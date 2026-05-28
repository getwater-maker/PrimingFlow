'use strict';

/**
 * VideoManager — 비디오 생성 provider 추상화
 *
 * 현재 지원:
 *   - runpod-comfy : RunPod ComfyUI + Wan2.2-I2V (이미지 → 비디오)
 *
 * 사용:
 *   const { getInstance } = require('./video/video-manager');
 *   const mgr = getInstance();
 *   await mgr.start();
 *   const result = await mgr.synth({
 *     inputImagePath: 'D:/.../images/01.png',
 *     motionPrompt: 'gentle camera push-in',
 *     outputPath: 'D:/.../videos/01.mp4',
 *     onProgress: p => console.log(p),
 *   });
 *
 * ImageManager 패턴 동일.
 */

class VideoManager {
    constructor(opts = {}) {
        this.opts = opts;
        this.providers = new Map();
        this.logger = typeof opts.logger === 'function' ? opts.logger : () => {};
        this._started = false;
    }

    async start() {
        if (this._started) return;
        this._started = true;

        try {
            const { RunPodComfyVideoProvider } = require('./providers/runpod-comfy-provider');
            const p = new RunPodComfyVideoProvider();
            const ok = await p.init();
            if (ok) {
                this.providers.set('runpod-comfy', p);
                this.logger('[Video] RunPod ComfyUI (Wan2.2) provider 초기화 완료');
            } else {
                this.logger('[Video] RunPod ComfyUI provider 초기화 실패 — RunPod 설정 확인');
            }
        } catch (e) {
            this.logger(`[Video] provider 로드 예외: ${e.message}`);
        }
    }

    async stop() {
        for (const p of this.providers.values()) {
            if (typeof p.stop === 'function') {
                try { await p.stop(); } catch {}
            }
        }
        this.providers.clear();
        this._started = false;
    }

    isAvailable(id = 'runpod-comfy') {
        const p = this.providers.get(id);
        return !!(p && p.ready);
    }

    getProvider(id = 'runpod-comfy') {
        return this.providers.get(id) || null;
    }

    listAvailable() {
        return Array.from(this.providers.entries())
            .filter(([, p]) => p.ready)
            .map(([id, p]) => ({ id, label: p.label || id }));
    }

    /**
     * 비디오 1개 생성.
     * @param {object} opts - RunPodComfyVideoProvider.synth 와 동일 인터페이스
     *   - inputImagePath, motionPrompt, negativePrompt, workflowName
     *   - width, height, frames, steps, cfg, seed, outputPath, onProgress
     *   - provider: 'runpod-comfy' (기본)
     */
    async synth(opts = {}) {
        if (!this._started) await this.start();
        const id = opts.provider || 'runpod-comfy';
        const p = this.providers.get(id);
        if (!p || !p.ready) {
            throw new Error(`비디오 provider '${id}' 비활성 — RunPod 설정 확인`);
        }
        return await p.synth(opts);
    }
}

let _instance = null;
function getInstance(opts) {
    if (!_instance) {
        _instance = new VideoManager(opts);
    } else if (opts && opts.logger && typeof opts.logger === 'function') {
        _instance.logger = opts.logger;
    }
    return _instance;
}

module.exports = { VideoManager, getInstance };
