'use strict';

/**
 * ImageManager — 이미지 생성 provider 추상화
 *
 * 현재 지원:
 *   - runpod-comfy : RunPod ComfyUI Pod 자동 시동 + SDXL 생성
 *
 * 사용:
 *   const { getInstance } = require('./image/image-manager');
 *   const mgr = getInstance();
 *   await mgr.start();
 *   const result = await mgr.synth({
 *     prompt: 'a korean palace',
 *     outputPath: 'D:/.../images/01.png',
 *     onProgress: p => console.log(p)
 *   });
 *
 * TTSManager 패턴 그대로 복제. provider 등록은 start() 에서 일괄 처리.
 */

'use strict';

class ImageManager {
    constructor(opts = {}) {
        this.opts = opts;
        this.providers = new Map();
        this.logger = typeof opts.logger === 'function' ? opts.logger : () => {};
        this._started = false;
    }

    /** provider 초기화. Idempotent — 여러 번 호출해도 한 번만 실행. */
    async start() {
        if (this._started) return;
        this._started = true;

        // RunPod ComfyUI
        try {
            const { RunPodComfyProvider } = require('./providers/runpod-comfy-provider');
            const p = new RunPodComfyProvider();
            const ok = await p.init();
            if (ok) {
                this.providers.set('runpod-comfy', p);
                this.logger('[Image] RunPod ComfyUI provider 초기화 완료');
            } else {
                this.logger('[Image] RunPod ComfyUI provider 초기화 실패 — RunPod 설정 확인');
            }
        } catch (e) {
            this.logger(`[Image] RunPod provider 로드 예외: ${e.message}`);
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
     * 이미지 1장 생성.
     * @param {object} opts - RunPodComfyProvider.synth 와 동일 인터페이스
     *   - prompt, negativePrompt, workflowName, width, height, seed, steps, cfg, outputPath, onProgress
     *   - provider: 'runpod-comfy' (기본)
     */
    async synth(opts = {}) {
        if (!this._started) await this.start();
        const id = opts.provider || 'runpod-comfy';
        const p = this.providers.get(id);
        if (!p || !p.ready) {
            throw new Error(`이미지 provider '${id}' 비활성 — 시크릿/설정 확인`);
        }
        return await p.synth(opts);
    }
}

// 모듈 레벨 싱글톤
let _instance = null;
function getInstance(opts) {
    if (!_instance) {
        _instance = new ImageManager(opts);
    } else if (opts && opts.logger && typeof opts.logger === 'function') {
        _instance.logger = opts.logger;
    }
    return _instance;
}

module.exports = { ImageManager, getInstance };
