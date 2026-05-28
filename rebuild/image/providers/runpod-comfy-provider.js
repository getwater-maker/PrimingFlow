'use strict';

/**
 * RunPod ComfyUI Provider
 *
 * 워크플로 JSON + manifest 로드 → 슬롯에 prompt/seed/size 주입 →
 * PodController 로 Pod 시동/재활용 → ComfyUI /prompt 호출 →
 * /history 폴링 → /view 로 결과 다운로드 → 로컬 저장
 *
 * 사용 예:
 *   const provider = new RunPodComfyProvider();
 *   await provider.init();
 *   const res = await provider.synth({
 *     prompt: 'a korean palace at sunset',
 *     workflowName: 'sdxl-basic',
 *     outputPath: 'D:/.../images/01.png',
 *     onProgress: p => console.log(p),
 *   });
 */

const fs = require('fs');
const path = require('path');

const WORKFLOWS_DIR = path.join(__dirname, '..', '..', 'runpod', 'workflows');

function loadWorkflow(name) {
    const wfPath = path.join(WORKFLOWS_DIR, `${name}.json`);
    const manifestPath = path.join(WORKFLOWS_DIR, `${name}.manifest.json`);
    if (!fs.existsSync(wfPath)) throw new Error(`워크플로 없음: ${wfPath}`);
    if (!fs.existsSync(manifestPath)) throw new Error(`매니페스트 없음: ${manifestPath}`);
    const workflow = JSON.parse(fs.readFileSync(wfPath, 'utf-8'));
    const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf-8'));
    return { workflow: JSON.parse(JSON.stringify(workflow)), manifest };
}

function injectSlot(workflow, slot, value) {
    if (!slot) return;
    if (!workflow[slot.nodeId]) {
        throw new Error(`슬롯 노드 ${slot.nodeId} 가 워크플로에 없음`);
    }
    workflow[slot.nodeId].inputs[slot.inputKey] = value;
}

async function fetchWithTimeout(url, options = {}, timeoutMs = 30_000) {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), timeoutMs);
    try {
        return await fetch(url, { ...options, signal: ctrl.signal });
    } finally {
        clearTimeout(timer);
    }
}

/**
 * ComfyUI 가 인식하는 checkpoint 목록을 조회.
 * ComfyUI 가 시작 직후 모델 스캔 중일 수 있으므로 최대 waitMs 동안 재시도.
 * 목록이 비어있지 않으면 즉시 반환.
 */
async function _fetchCheckpoints(endpointUrl, waitMs = 120_000) {
    const deadline = Date.now() + waitMs;
    let lastList = [];
    while (Date.now() < deadline) {
        try {
            const r = await fetchWithTimeout(`${endpointUrl}/object_info/CheckpointLoaderSimple`, {}, 10_000);
            const j = await r.json();
            lastList = j?.CheckpointLoaderSimple?.input?.required?.ckpt_name?.[0] || [];
            if (lastList.length > 0) {
                console.log('[runpod-comfy] checkpoints:', lastList);
                return lastList;
            }
        } catch {}
        await new Promise(r => setTimeout(r, 6_000));
    }
    console.warn('[runpod-comfy] checkpoint 목록 조회 타임아웃 — 목록:', lastList);
    return lastList;
}

/** checkpoint 목록에서 SDXL base 모델명 찾기 (경로 형식 무관) */
function _pickSdxlName(list) {
    if (!list || list.length === 0) return null;
    // 1) 정확히 일치
    const exact = list.find(n => n === 'SDXL/sd_xl_base_1.0.safetensors');
    if (exact) return exact;
    // 2) 파일명 부분 일치
    const byFile = list.find(n => n.replace(/\\/g, '/').includes('sd_xl_base_1.0'));
    if (byFile) return byFile;
    // 3) sdxl 키워드 — base 우선
    const sdxlBase = list.find(n => /sdxl.*base/i.test(n) || /stable.diffusion.xl.base/i.test(n));
    if (sdxlBase) return sdxlBase;
    return null;
}

/**
 * Manager API 로 SDXL 모델 재등록 시도.
 * 파일이 볼륨에 있으면 15~30초, 없으면 긴 다운로드 → 타임아웃 후 null 반환.
 * 반환값: 등록 성공 시 체크포인트 이름, 실패 시 null.
 */
async function _registerAndWait(endpointUrl) {
    const CKPT = 'SDXL/sd_xl_base_1.0.safetensors';
    try {
        await fetchWithTimeout(`${endpointUrl}/manager/queue/install_model`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                type: 'checkpoints',
                url: 'https://huggingface.co/stabilityai/stable-diffusion-xl-base-1.0/resolve/main/sd_xl_base_1.0.safetensors',
                filename: CKPT,
                save_path: `models/checkpoints/${CKPT}`,
            }),
        }, 15_000);
        await fetchWithTimeout(`${endpointUrl}/manager/queue/start`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: '{}',
        }, 10_000);
    } catch (e) {
        console.warn('[runpod-comfy] Manager API 호출 실패:', e.message);
        return null;
    }
    // 최대 120초 대기 (볼륨에 있으면 ~30초, 없으면 타임아웃)
    const deadline = Date.now() + 120_000;
    while (Date.now() < deadline) {
        await new Promise(r => setTimeout(r, 6_000));
        const list = await _fetchCheckpoints(endpointUrl, 1).catch(() => []);
        const found = _pickSdxlName(list);
        if (found) { console.log('[runpod-comfy] ✅ 모델 등록 완료:', found); return found; }
    }
    return null;
}

class RunPodComfyProvider {
    constructor(opts = {}) {
        this.ready = false;
        this.label = 'RunPod ComfyUI';
        this.opts = opts;
    }

    async init() {
        try {
            require('../../runpod/pod-controller');
            this.ready = true;
            return true;
        } catch (e) {
            console.error('[runpod-comfy] PodController 로드 실패:', e.message);
            this.ready = false;
            return false;
        }
    }

    async stop() {
        this.ready = false;
    }

    /**
     * 이미지 생성.
     * @param {object} opts
     * @param {string} opts.prompt - 영문 프롬프트 (한국어는 Qwen 워크플로 사용 시만)
     * @param {string} [opts.negativePrompt]
     * @param {string} [opts.workflowName='sdxl-basic']
     * @param {number} [opts.width]
     * @param {number} [opts.height]
     * @param {number} [opts.seed=-1] - -1 이면 랜덤
     * @param {number} [opts.steps]
     * @param {number} [opts.cfg]
     * @param {string} opts.outputPath - 결과 저장 절대경로
     * @param {Function} [opts.onProgress] - (0~1) 콜백
     * @returns {Promise<{path, width, height, durationMs, seed}>}
     */
    async synth(opts = {}) {
        const t0 = Date.now();
        const {
            prompt,
            negativePrompt,
            workflowName = 'sdxl-basic',
            width,
            height,
            seed,
            steps,
            cfg,
            outputPath,
            onProgress,
        } = opts;

        if (!prompt) throw new Error('prompt 필수');
        if (!outputPath) throw new Error('outputPath 필수');

        const progress = (p) => { try { onProgress && onProgress(p); } catch {} };

        // 1. Pod 확보
        progress(0.02);
        const { PodController } = require('../../runpod/pod-controller');
        const podCtrl = PodController.getInstance();
        const { endpointUrl } = await podCtrl.ensureRunning();
        podCtrl.notifyActivity();

        // 2. 워크플로 로드 + 슬롯 주입
        const { workflow, manifest } = loadWorkflow(workflowName);
        const slots = manifest.slots || {};
        const defaults = manifest.defaults || {};

        // 2a. 제출 전 checkpoint 목록 확인 (ComfyUI 시작 후 모델 스캔이 끝날 때까지 최대 2분 대기)
        progress(0.05);
        console.log('[runpod-comfy] ComfyUI checkpoint 목록 조회 중...');
        let ckptList = await _fetchCheckpoints(endpointUrl, 120_000);
        let ckptName = _pickSdxlName(ckptList);

        if (!ckptName) {
            // 목록에 없음 → Manager API 로 등록 시도
            console.log('[runpod-comfy] SDXL 없음 — Manager API 재등록 시도 (현재 목록:', ckptList, ')');
            progress(0.07);
            ckptName = await _registerAndWait(endpointUrl);
            if (!ckptName) {
                // 마지막 목록 재조회
                ckptList = await _fetchCheckpoints(endpointUrl, 10_000);
                ckptName = _pickSdxlName(ckptList) || ckptList[0] || null;
            }
        }

        if (!ckptName) {
            throw new Error(
                `ComfyUI에 사용 가능한 checkpoint 없음.\n` +
                `현재 목록: [${ckptList.join(', ')}]\n` +
                `RunPod 대시보드에서 Pod에 네트워크 볼륨(lkkfxotjok)이 연결됐는지 확인 후 재시도하세요.`
            );
        }

        console.log('[runpod-comfy] 사용할 checkpoint:', ckptName);

        // 2b. 체크포인트 이름 동적 주입 (workflow 의 CheckpointLoaderSimple 노드)
        const ckptNodeId = manifest.slots?.checkpoint?.nodeId || '4';
        if (workflow[ckptNodeId] && workflow[ckptNodeId].class_type === 'CheckpointLoaderSimple') {
            workflow[ckptNodeId].inputs.ckpt_name = ckptName;
        }

        injectSlot(workflow, slots.prompt, prompt);
        injectSlot(workflow, slots.negativePrompt, negativePrompt || defaults.negativePrompt || '');
        const finalWidth  = width  || defaults.width  || 1024;
        const finalHeight = height || defaults.height || 1024;
        injectSlot(workflow, slots.width, finalWidth);
        injectSlot(workflow, slots.height, finalHeight);
        if (steps != null) injectSlot(workflow, slots.steps, steps);
        else if (defaults.steps != null) injectSlot(workflow, slots.steps, defaults.steps);
        if (cfg != null) injectSlot(workflow, slots.cfg, cfg);
        else if (defaults.cfg != null) injectSlot(workflow, slots.cfg, defaults.cfg);
        const finalSeed = (seed == null || seed === -1) ? Math.floor(Math.random() * 1e9) : seed;
        injectSlot(workflow, slots.seed, finalSeed);
        if (slots.filenamePrefix) {
            injectSlot(workflow, slots.filenamePrefix, `pf_${Date.now()}_${finalSeed}`);
        }

        // 3. 제출
        progress(0.08);
        const clientId = `pf_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
        const submitResp2 = await fetchWithTimeout(`${endpointUrl}/prompt`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ prompt: workflow, client_id: clientId }),
        }, 30_000);
        let submit = await submitResp2.json();

        if (submit.error) {
            throw new Error(`ComfyUI 제출 거부: ${JSON.stringify(submit.error)}`);
        }
        if (submit.node_errors && Object.keys(submit.node_errors).length > 0) {
            throw new Error(`워크플로 검증 실패: ${JSON.stringify(submit.node_errors)}`);
        }
        const promptId = submit.prompt_id;
        if (!promptId) throw new Error('prompt_id 응답 없음');

        // 4. 폴링 (최대 5분 — RTX 3090 SDXL = 3초, 모델 첫 로드 시 10~30초)
        progress(0.15);
        const deadline = Date.now() + 300_000;
        let outputs = null;
        let pollCount = 0;
        while (Date.now() < deadline) {
            await new Promise(r => setTimeout(r, 2000));
            pollCount++;
            try {
                const hResp = await fetchWithTimeout(`${endpointUrl}/history/${promptId}`, {}, 10_000);
                const h = await hResp.json();
                if (h[promptId] && h[promptId].status && h[promptId].status.completed) {
                    outputs = h[promptId].outputs;
                    break;
                }
            } catch {}
            // 진행률은 시간 기반으로 슬슬 올림 (정확한 진행률은 ws 필요)
            const elapsed = Date.now() - t0;
            const estimate = Math.min(0.15 + (elapsed / 30_000) * 0.7, 0.85);
            progress(estimate);
        }
        if (!outputs) throw new Error('ComfyUI 생성 타임아웃 (5분)');

        // 5. 출력 이미지 정보 추출
        const outNodeId = manifest.output && manifest.output.nodeId;
        const nodeOut = outputs[outNodeId] || Object.values(outputs).find(v => v && v.images);
        if (!nodeOut || !nodeOut.images || nodeOut.images.length === 0) {
            throw new Error('출력 이미지 없음 — 워크플로 점검 필요');
        }
        const imgInfo = nodeOut.images[0];

        // 6. 결과 다운로드
        progress(0.9);
        const viewUrl = `${endpointUrl}/view?filename=${encodeURIComponent(imgInfo.filename)}&subfolder=${encodeURIComponent(imgInfo.subfolder || '')}&type=${encodeURIComponent(imgInfo.type || 'output')}`;
        const viewResp = await fetchWithTimeout(viewUrl, {}, 60_000);
        if (!viewResp.ok) throw new Error(`결과 다운로드 실패: HTTP ${viewResp.status}`);
        const arrayBuf = await viewResp.arrayBuffer();

        fs.mkdirSync(path.dirname(outputPath), { recursive: true });
        fs.writeFileSync(outputPath, Buffer.from(arrayBuf));

        podCtrl.notifyActivity();
        progress(1.0);

        return {
            path: outputPath,
            width: finalWidth,
            height: finalHeight,
            durationMs: Date.now() - t0,
            seed: finalSeed,
        };
    }
}

module.exports = { RunPodComfyProvider };
