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
        // 파일명 prefix — 충돌 방지용 시드 포함
        if (slots.filenamePrefix) {
            injectSlot(workflow, slots.filenamePrefix, `pf_${Date.now()}_${finalSeed}`);
        }

        // 3. 제출
        progress(0.08);
        const clientId = `pf_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
        const submitResp = await fetchWithTimeout(`${endpointUrl}/prompt`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ prompt: workflow, client_id: clientId }),
        }, 30_000);

        const submit = await submitResp.json();
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
