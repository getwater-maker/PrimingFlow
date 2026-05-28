'use strict';

/**
 * RunPod ComfyUI Video Provider (Wan2.2-I2V)
 *
 * 이미지 1장 → 5초 720p 비디오.
 * 워크플로: rebuild/runpod/workflows/wan22-i2v-720p.json
 *
 * 모델 사전 설치 필요 (네트워크 볼륨):
 *   - Wan2.2-I2V-A14B-fp8.safetensors (~17GB)
 *   - Wan2_1_VAE_bf16.safetensors (~1GB)
 *   - umt5-xxl-enc-bf16.safetensors (~10GB)
 *
 * 사용 예:
 *   const p = new RunPodComfyVideoProvider();
 *   await p.init();
 *   const res = await p.synth({
 *     inputImagePath: 'D:/.../images/01.png',
 *     motionPrompt: 'gentle camera push-in, subtle natural movement',
 *     outputPath: 'D:/.../videos/01.mp4',
 *     onProgress: p => console.log(p),
 *   });
 */

const fs = require('fs');
const path = require('path');
const os = require('os');

const WORKFLOWS_DIR = path.join(__dirname, '..', '..', 'runpod', 'workflows');

function loadWorkflow(name) {
    const wfPath = path.join(WORKFLOWS_DIR, `${name}.json`);
    const manifestPath = path.join(WORKFLOWS_DIR, `${name}.manifest.json`);
    if (!fs.existsSync(wfPath)) throw new Error(`워크플로 없음: ${wfPath}`);
    if (!fs.existsSync(manifestPath)) throw new Error(`매니페스트 없음: ${manifestPath}`);
    const workflow = JSON.parse(fs.readFileSync(wfPath, 'utf-8'));
    const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf-8'));
    if (workflow._placeholder) {
        throw new Error('비디오 워크플로가 아직 검증되지 않았습니다. ComfyUI에서 Wan2.2 I2V 예제를 실행하여 wan22-i2v-720p.json을 교체하세요.');
    }
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

/** 이미지 파일을 ComfyUI /upload/image 엔드포인트로 업로드. 반환값: 서버에서 인식하는 파일명 */
async function uploadImageToComfy(endpointUrl, imagePath, uploadName) {
    const imageData = fs.readFileSync(imagePath);
    const boundary = `----FormBoundary${Date.now().toString(36)}`;

    const header = Buffer.from(
        `--${boundary}\r\nContent-Disposition: form-data; name="image"; filename="${uploadName}"\r\nContent-Type: image/png\r\n\r\n`
    );
    const footer = Buffer.from(`\r\n--${boundary}--\r\n`);
    const body = Buffer.concat([header, imageData, footer]);

    const resp = await fetchWithTimeout(`${endpointUrl}/upload/image`, {
        method: 'POST',
        headers: {
            'Content-Type': `multipart/form-data; boundary=${boundary}`,
            'Content-Length': String(body.length),
        },
        body,
    }, 30_000);

    if (!resp.ok) throw new Error(`이미지 업로드 실패: HTTP ${resp.status}`);
    const json = await resp.json();
    return json.name || uploadName;
}

class RunPodComfyVideoProvider {
    constructor(opts = {}) {
        this.ready = false;
        this.label = 'RunPod ComfyUI (Wan2.2)';
        this.opts = opts;
    }

    async init() {
        try {
            require('../../runpod/pod-controller');
            this.ready = true;
            return true;
        } catch (e) {
            console.error('[runpod-comfy-video] PodController 로드 실패:', e.message);
            this.ready = false;
            return false;
        }
    }

    async stop() {
        this.ready = false;
    }

    /**
     * 비디오 생성.
     * @param {object} opts
     * @param {string} opts.inputImagePath - 시작 프레임 이미지 절대경로 (PNG/JPG)
     * @param {string} [opts.motionPrompt] - 움직임/분위기 영문 프롬프트
     * @param {string} [opts.negativePrompt]
     * @param {string} [opts.workflowName='wan22-i2v-720p']
     * @param {number} [opts.width] [opts.height] [opts.frames] [opts.steps] [opts.cfg]
     * @param {number} [opts.seed=-1]
     * @param {string} opts.outputPath - 결과 mp4 절대경로
     * @param {Function} [opts.onProgress] - (0~1) 콜백
     * @returns {Promise<{path, width, height, frames, durationMs, seed}>}
     */
    async synth(opts = {}) {
        const t0 = Date.now();
        const {
            inputImagePath,
            motionPrompt,
            negativePrompt,
            workflowName = 'wan22-i2v-720p',
            width,
            height,
            frames,
            steps,
            cfg,
            seed,
            outputPath,
            onProgress,
        } = opts;

        if (!inputImagePath) throw new Error('inputImagePath 필수');
        if (!outputPath) throw new Error('outputPath 필수');
        if (!fs.existsSync(inputImagePath)) throw new Error(`입력 이미지 없음: ${inputImagePath}`);

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

        // 2a. 입력 이미지 업로드 → 서버 파일명 확인
        progress(0.06);
        const uploadName = slots.inputImage && slots.inputImage.uploadName || 'input_image.png';
        const serverImageName = await uploadImageToComfy(endpointUrl, inputImagePath, uploadName);
        injectSlot(workflow, slots.inputImage, serverImageName);

        // 2b. 나머지 슬롯
        injectSlot(workflow, slots.motionPrompt, motionPrompt || defaults.motionPrompt || '');
        injectSlot(workflow, slots.negativePrompt, negativePrompt || defaults.negativePrompt || '');
        const finalWidth  = width  || defaults.width  || 1280;
        const finalHeight = height || defaults.height || 720;
        const finalFrames = frames || defaults.frames || 81;
        injectSlot(workflow, slots.width, finalWidth);
        injectSlot(workflow, slots.height, finalHeight);
        injectSlot(workflow, slots.frames, finalFrames);
        if (steps != null) injectSlot(workflow, slots.steps, steps);
        else if (defaults.steps != null) injectSlot(workflow, slots.steps, defaults.steps);
        if (cfg != null) injectSlot(workflow, slots.cfg, cfg);
        else if (defaults.cfg != null) injectSlot(workflow, slots.cfg, defaults.cfg);
        const finalSeed = (seed == null || seed === -1) ? Math.floor(Math.random() * 1e9) : seed;
        injectSlot(workflow, slots.seed, finalSeed);
        if (slots.frameRate && defaults.frameRate) {
            injectSlot(workflow, slots.frameRate, defaults.frameRate);
        }

        // 3. 제출
        progress(0.1);
        const clientId = `pf_vid_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
        const submitResp = await fetchWithTimeout(`${endpointUrl}/prompt`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ prompt: workflow, client_id: clientId }),
        }, 30_000);

        const submit = await submitResp.json();
        if (submit.error) throw new Error(`ComfyUI 제출 거부: ${JSON.stringify(submit.error)}`);
        if (submit.node_errors && Object.keys(submit.node_errors).length > 0) {
            throw new Error(`워크플로 검증 실패: ${JSON.stringify(submit.node_errors)}`);
        }
        const promptId = submit.prompt_id;
        if (!promptId) throw new Error('prompt_id 응답 없음');

        // 4. 폴링 (최대 15분 — Wan2.2 81프레임 RTX 3090 기준 약 4~8분)
        progress(0.15);
        const deadline = Date.now() + 900_000;
        let outputs = null;
        while (Date.now() < deadline) {
            await new Promise(r => setTimeout(r, 5000));
            try {
                const hResp = await fetchWithTimeout(`${endpointUrl}/history/${promptId}`, {}, 15_000);
                const h = await hResp.json();
                if (h[promptId] && h[promptId].status && h[promptId].status.completed) {
                    outputs = h[promptId].outputs;
                    break;
                }
            } catch {}
            const elapsed = Date.now() - t0;
            const estimate = Math.min(0.15 + (elapsed / 480_000) * 0.75, 0.88);
            progress(estimate);
        }
        if (!outputs) throw new Error('ComfyUI 비디오 생성 타임아웃 (15분)');

        // 5. 출력 비디오 정보 추출
        const outNodeId = manifest.output && manifest.output.nodeId;
        const nodeOut = outputs[outNodeId] || Object.values(outputs).find(v => v && (v.videos || v.gifs || v.images));
        if (!nodeOut) throw new Error('출력 비디오 없음 — 워크플로 점검 필요');

        const vidList = nodeOut.videos || nodeOut.gifs || nodeOut.images || [];
        if (!vidList.length) throw new Error('출력 비디오 파일 없음');
        const vidInfo = vidList[0];

        // 6. 결과 다운로드
        progress(0.92);
        const viewUrl = `${endpointUrl}/view?filename=${encodeURIComponent(vidInfo.filename)}&subfolder=${encodeURIComponent(vidInfo.subfolder || '')}&type=${encodeURIComponent(vidInfo.type || 'output')}`;
        const viewResp = await fetchWithTimeout(viewUrl, {}, 120_000);
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
            frames: finalFrames,
            durationMs: Date.now() - t0,
            seed: finalSeed,
        };
    }
}

module.exports = { RunPodComfyVideoProvider };
