'use strict';

/**
 * PodController — RunPod GraphQL API 래퍼
 *
 * Pod 시동 → ComfyUI 준비 대기 → idle 자동 종료 → Spot preempt 감지
 *
 * 시크릿 구조 (SecretStore 'runpod' 키):
 *   { apiKey, templateId, gpuTypes, cloudType, bidPerGpu, idleShutdownMinutes }
 *
 * 이벤트: 'ready', 'stopped', 'preempted', 'error'
 */

const EventEmitter = require('events');
const https = require('https');
const fs = require('fs');
const path = require('path');
const os = require('os');

const GRAPHQL_URL = 'https://api.runpod.io/graphql';
const STATE_PATH = path.join(os.homedir(), '.flow-app', 'runpod-state.json');
const STATE_DIR = path.join(os.homedir(), '.flow-app');

// EU-CZ-1 Secure Cloud 실측 가격 오름차순 (2026-05-28 기준)
const DEFAULT_GPU_TYPES = [
    'NVIDIA RTX A5000',         // $0.27/h, 24GB ★ 최저가
    'NVIDIA A40',                // $0.44/h, 48GB (비디오 여유)
    'NVIDIA GeForce RTX 3090',   // $0.46/h, 24GB
    'NVIDIA RTX 3090',
    'NVIDIA RTX A6000',          // $0.49/h, 48GB
    'NVIDIA RTX PRO 4500',       // $0.74/h, 32GB (HIGH 재고)
    'NVIDIA RTX 4090',           // $0.69/h, 24GB
    'NVIDIA GeForce RTX 4090',
    'NVIDIA L40S',
];
// 이미지/비디오 모델이 요구하는 최소 VRAM (GB). 이 미만 GPU는 자동 제외.
const MIN_VRAM_GB = 20;
const DEFAULT_IDLE_MINUTES = 5;
const DEFAULT_TEMPLATE_ID = 'kwb51e5pmc';

function podEndpointUrl(podId) {
    return `https://${podId}-8188.proxy.runpod.net`;
}

function sleep(ms) {
    return new Promise(r => setTimeout(r, ms));
}

async function fetchJson(url, options = {}) {
    const timeoutMs = options._timeout || 15_000;
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), timeoutMs);
    try {
        const resp = await fetch(url, { ...options, signal: ctrl.signal });
        const text = await resp.text();
        try {
            return JSON.parse(text);
        } catch {
            throw new Error(`JSON 파싱 실패 (HTTP ${resp.status}): ${text.slice(0, 200)}`);
        }
    } finally {
        clearTimeout(timer);
    }
}

class PodController extends EventEmitter {
    constructor() {
        super();
        this._podId = null;
        this._endpointUrl = null;
        this._state = 'stopped'; // 'stopped' | 'starting' | 'running' | 'stopping'
        this._idleTimer = null;
        this._healthTimer = null;
        this._startPromise = null;
        this._loadState();
    }

    static getInstance() {
        if (!PodController._instance) {
            PodController._instance = new PodController();
        }
        return PodController._instance;
    }

    _loadState() {
        try {
            if (fs.existsSync(STATE_PATH)) {
                const s = JSON.parse(fs.readFileSync(STATE_PATH, 'utf-8'));
                if (s.podId) {
                    this._podId = s.podId;
                    // 앱 재시작 시 복원 — ensureRunning()에서 실제 생존 여부 확인
                }
            }
        } catch {}
    }

    _saveState() {
        try {
            fs.mkdirSync(STATE_DIR, { recursive: true });
            fs.writeFileSync(STATE_PATH, JSON.stringify({ podId: this._podId }), 'utf-8');
        } catch {}
    }

    _clearState() {
        try {
            fs.mkdirSync(STATE_DIR, { recursive: true });
            fs.writeFileSync(STATE_PATH, JSON.stringify({}), 'utf-8');
        } catch {}
    }

    _getSecret() {
        const SecretStore = require('../tts/secret-store');
        const s = SecretStore.get('runpod');
        if (!s || !s.apiKey) {
            throw new Error('[RunPod] API Key 미설정 — 🔑 키 버튼 → RunPod 탭에서 설정 필요');
        }
        return s;
    }

    async _graphql(query, variables = {}) {
        const secret = this._getSecret();
        const body = JSON.stringify({ query, variables });

        return new Promise((resolve, reject) => {
            const req = https.request(
                {
                    hostname: 'api.runpod.io',
                    path: '/graphql',
                    method: 'POST',
                    headers: {
                        'Content-Type': 'application/json',
                        'Authorization': `Bearer ${secret.apiKey}`,
                        'Content-Length': Buffer.byteLength(body),
                    },
                },
                (res) => {
                    let data = '';
                    res.on('data', chunk => (data += chunk));
                    res.on('end', () => {
                        try {
                            const parsed = JSON.parse(data);
                            if (parsed.errors) {
                                reject(new Error(`GraphQL: ${parsed.errors.map(e => e.message).join(', ')}`));
                            } else {
                                resolve(parsed.data);
                            }
                        } catch (e) {
                            reject(new Error(`응답 파싱 실패: ${data.slice(0, 300)}`));
                        }
                    });
                }
            );
            req.setTimeout(20_000, () => {
                req.destroy();
                reject(new Error('GraphQL 요청 타임아웃 (20s)'));
            });
            req.on('error', reject);
            req.write(body);
            req.end();
        });
    }

    async _findRunningPod() {
        const data = await this._graphql(`
            query {
                myself {
                    pods {
                        id
                        name
                        desiredStatus
                        runtime { uptimeInSeconds }
                    }
                }
            }
        `);
        const pods = (data && data.myself && data.myself.pods) || [];
        return pods.find(p => p.name === 'PrimingFlow-ComfyUI' && p.desiredStatus === 'RUNNING') || null;
    }

    async _queryPod(podId) {
        const data = await this._graphql(
            `query($podId: String!) {
                pod(input: { podId: $podId }) {
                    id
                    desiredStatus
                    runtime { uptimeInSeconds }
                }
            }`,
            { podId }
        );
        return (data && data.pod) || null;
    }

    /** Community Cloud 에서 현재 재고 있는 GPU 목록 반환 */
    async listAvailableGpus() {
        const data = await this._graphql(`
            query {
                gpuTypes {
                    id
                    displayName
                    memoryInGb
                    communityCloud
                    communityPrice
                }
            }
        `);
        const all = (data && data.gpuTypes) || [];
        return all.filter(g => g.communityCloud);
    }

    async _deployPod(gpuTypeId) {
        const secret = this._getSecret();
        const templateId = secret.templateId || DEFAULT_TEMPLATE_ID;

        // 템플릿이 image/ports/env/volumeMountPath 를 모두 가지고 있으므로
        // 여기선 인프라 설정(GPU, 볼륨, DC)만 명시.
        const input = {
            cloudType: secret.cloudType || 'COMMUNITY',
            gpuCount: 1,
            minVcpuCount: 2,
            minMemoryInGb: 16,
            gpuTypeId,
            name: 'PrimingFlow-ComfyUI',
            templateId,
            startSsh: false,
        };

        // 네트워크 볼륨 (모델 영구 저장)
        if (secret.networkVolumeId) {
            input.networkVolumeId = secret.networkVolumeId;
        }

        // 데이터센터 — 볼륨이 있는 지역으로 강제 (RunPod API 는 단일 문자열)
        if (secret.dataCenterId) {
            input.dataCenterId = secret.dataCenterId;
        }

        const data = await this._graphql(
            `mutation($input: PodFindAndDeployOnDemandInput!) {
                podFindAndDeployOnDemand(input: $input) {
                    id
                    imageName
                }
            }`,
            { input }
        );
        const pod = data && data.podFindAndDeployOnDemand;
        if (!pod) throw new Error(`${gpuTypeId} 배포 실패 — GPU 없음 또는 잔액 부족 (${secret.dataCenterId || 'any DC'})`);
        return pod.id;
    }

    async _pollPodRunning(podId, timeoutMs = 300_000) {
        const deadline = Date.now() + timeoutMs;
        let lastStatus = '';
        let elapsed = 0;
        while (Date.now() < deadline) {
            const pod = await this._queryPod(podId);
            if (!pod) throw new Error(`Pod ${podId} 조회 결과 없음`);
            if (pod.desiredStatus !== lastStatus) {
                lastStatus = pod.desiredStatus;
                console.log(`[RunPod] Pod ${podId} 상태: ${lastStatus} (${Math.round(elapsed / 1000)}s)`);
                this.emit('status', { phase: 'pod', status: lastStatus, podId, elapsedSec: Math.round(elapsed / 1000) });
            }
            if (pod.desiredStatus === 'RUNNING' && pod.runtime) return pod;
            if (pod.desiredStatus === 'EXITED' || pod.desiredStatus === 'TERMINATED') {
                throw new Error(`Pod ${podId} 이 ${pod.desiredStatus} 상태 — Spot preempt 또는 이미지/잔액 오류`);
            }
            await sleep(5_000);
            elapsed += 5_000;
        }
        throw new Error(`Pod RUNNING 대기 타임아웃 (${Math.round(timeoutMs / 60000)}분) — RunPod 대시보드에서 Pod 상태 확인 필요`);
    }

    async _waitComfyUI(endpointUrl, timeoutMs = 300_000) {
        const deadline = Date.now() + timeoutMs;
        let lastErr = '';
        let elapsed = 0;
        while (Date.now() < deadline) {
            try {
                const json = await fetchJson(`${endpointUrl}/queue`, { _timeout: 8_000 });
                if (json && typeof json === 'object') return;
            } catch (e) {
                lastErr = e.message;
            }
            if (elapsed % 30_000 < 5_000) {
                console.log(`[RunPod] ComfyUI 대기 중... ${Math.round(elapsed / 1000)}s (첫 부팅 시 모델 다운로드로 5~15분 소요)`);
                this.emit('status', { phase: 'comfyui', elapsedSec: Math.round(elapsed / 1000) });
            }
            await sleep(5_000);
            elapsed += 5_000;
        }
        throw new Error(`ComfyUI 응답 대기 타임아웃 (${Math.round(timeoutMs / 60000)}분): ${lastErr}`);
    }

    /**
     * 새 Pod 시동 후 SDXL 모델이 ComfyUI object_info 에 없으면
     * Manager API 로 재등록(이미 볼륨에 있으면 다운로드 없이 15초 내 완료).
     */
    async _ensureSdxlModel(endpointUrl) {
        const CKPT = 'SDXL/sd_xl_base_1.0.safetensors';
        try {
            // 현재 등록된 checkpoint 목록 확인
            const info = await fetchJson(`${endpointUrl}/object_info/CheckpointLoaderSimple`, { _timeout: 15_000 });
            const opts = info?.CheckpointLoaderSimple?.input?.required?.ckpt_name?.[0] || [];
            if (Array.isArray(opts) && opts.some(n => n === CKPT || n.endsWith('sd_xl_base_1.0.safetensors'))) {
                console.log('[RunPod] SDXL 모델 확인 완료 — 바로 사용 가능');
                return;
            }
            console.log('[RunPod] SDXL 모델 미감지 — Manager API 로 재등록 중...');
        } catch {
            console.log('[RunPod] object_info 확인 실패 — 재등록 시도');
        }

        // Manager API: 모델 재등록 (파일이 볼륨에 있으면 다운로드 없이 즉시 등록)
        try {
            await fetchJson(`${endpointUrl}/manager/queue/install_model`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    type: 'checkpoints',
                    url: 'https://huggingface.co/stabilityai/stable-diffusion-xl-base-1.0/resolve/main/sd_xl_base_1.0.safetensors',
                    filename: CKPT,
                    save_path: `models/checkpoints/${CKPT}`,
                }),
                _timeout: 15_000,
            });
            await fetchJson(`${endpointUrl}/manager/queue/start`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: '{}',
                _timeout: 10_000,
            });
        } catch (e) {
            console.warn('[RunPod] Manager 재등록 요청 실패 (무시):', e.message);
            return;
        }

        // 최대 60초 대기 — 볼륨에 파일 있으면 보통 5~15초 내 완료
        const deadline = Date.now() + 60_000;
        while (Date.now() < deadline) {
            await sleep(4_000);
            try {
                const info = await fetchJson(`${endpointUrl}/object_info/CheckpointLoaderSimple`, { _timeout: 10_000 });
                const opts = info?.CheckpointLoaderSimple?.input?.required?.ckpt_name?.[0] || [];
                if (Array.isArray(opts) && opts.some(n => n === CKPT || n.endsWith('sd_xl_base_1.0.safetensors'))) {
                    console.log('[RunPod] ✅ SDXL 모델 등록 완료');
                    return;
                }
            } catch {}
        }
        console.warn('[RunPod] SDXL 모델 등록 확인 타임아웃 — 이미지 생성 시 실패할 수 있음');
    }

    /**
     * Pod 가 살아있으면 endpoint URL 즉시 반환, 아니면 시동 후 ready 까지 대기.
     * 동시 호출이 와도 첫 번째 call 이 끝날 때까지 직렬화.
     */
    async ensureRunning(opts = {}) {
        if (this._state === 'running' && this._endpointUrl) {
            // Pod 가 이미 실행 중이지만 이 세션에서 모델 등록 확인이 안 된 경우 체크
            if (this._podId && this._sdxlCheckedForPod !== this._podId) {
                this._sdxlCheckedForPod = this._podId;
                await this._ensureSdxlModel(this._endpointUrl).catch(() => {});
            }
            this.notifyActivity();
            return { endpointUrl: this._endpointUrl, podId: this._podId };
        }

        if (this._startPromise) {
            return this._startPromise;
        }

        this._startPromise = this._doStart(opts).finally(() => {
            this._startPromise = null;
        });
        return this._startPromise;
    }

    async _doStart() {
        this._state = 'starting';
        console.log('[RunPod] ensureRunning 시작...');

        try {
            let podId = null;

            // 1. 이전에 저장된 Pod ID로 재연결 시도
            if (this._podId) {
                console.log(`[RunPod] 저장된 Pod ID 확인: ${this._podId}`);
                try {
                    const pod = await this._queryPod(this._podId);
                    if (pod && pod.desiredStatus === 'RUNNING' && pod.runtime) {
                        podId = pod.id;
                        console.log('[RunPod] 기존 Pod 재연결 성공');
                    } else {
                        console.log('[RunPod] 저장된 Pod 비활성 — 새로 시동');
                        this._podId = null;
                    }
                } catch {
                    this._podId = null;
                }
            }

            // 2. 이름으로 실행 중인 Pod 탐색
            if (!podId) {
                console.log('[RunPod] 실행 중인 PrimingFlow Pod 탐색...');
                try {
                    const existing = await this._findRunningPod();
                    if (existing) {
                        podId = existing.id;
                        console.log(`[RunPod] 기존 Pod 발견: ${podId}`);
                    }
                } catch (e) {
                    console.log(`[RunPod] Pod 탐색 실패: ${e.message}`);
                }
            }

            // 3. 새 Pod 배포 — 재고 있는 GPU 우선, 없으면 전체 목록 순서대로 시도
            if (!podId) {
                const secret = this._getSecret();
                const preferredTypes = secret.gpuTypes || DEFAULT_GPU_TYPES;

                // preferred 목록만 시도 (RunPod 가 DC + 재고 자동 매칭).
                // 비싼 GPU(B200/B300 등)로 자동 폴백 방지 — 사용자 의도와 다른 청구 막음.
                const orderedTypes = [...preferredTypes];
                console.log(`[RunPod] 시도할 GPU 우선순위: ${orderedTypes.slice(0, 4).join(', ')}...`);

                let lastErr = null;
                for (const gpuType of orderedTypes) {
                    try {
                        console.log(`[RunPod] Pod 배포 중: ${gpuType}...`);
                        podId = await this._deployPod(gpuType);
                        console.log(`[RunPod] Pod 배포 완료: ${podId} (${gpuType})`);
                        break;
                    } catch (e) {
                        console.log(`[RunPod] ${gpuType} 배포 실패: ${e.message}`);
                        lastErr = e;
                    }
                }
                if (!podId) throw lastErr || new Error('모든 GPU 타입 배포 실패 — RunPod Community Cloud 재고 없음');
            }

            // 4. RUNNING 상태 대기 (최대 5분)
            console.log('[RunPod] Pod RUNNING 상태 대기...');
            await this._pollPodRunning(podId, 300_000);
            console.log(`[RunPod] Pod RUNNING 확인: ${podId}`);

            const endpointUrl = podEndpointUrl(podId);

            // 5. ComfyUI 8188 포트 응답 대기 (최대 5분 — 첫 부팅 모델 다운로드 포함)
            console.log(`[RunPod] ComfyUI 초기화 대기... (${endpointUrl})`);
            await this._waitComfyUI(endpointUrl, 300_000);

            // 6. SDXL 모델 등록 확인 — 새 Pod 는 네트워크 볼륨에 파일이 있어도
            //    ComfyUI 가 object_info 에 반영하려면 Manager 로 재등록 필요.
            await this._ensureSdxlModel(endpointUrl);
            this._sdxlCheckedForPod = podId;

            this._podId = podId;
            this._endpointUrl = endpointUrl;
            this._state = 'running';
            this._saveState();

            console.log(`[RunPod] ✅ 준비 완료 → ${endpointUrl}`);
            this.emit('ready', { endpointUrl, podId });

            this._startHealthMonitor();
            this.notifyActivity();

            return { endpointUrl, podId };
        } catch (e) {
            this._state = 'stopped';
            this.emit('error', e);
            throw e;
        }
    }

    _startHealthMonitor() {
        if (this._healthTimer) clearInterval(this._healthTimer);
        this._healthTimer = setInterval(async () => {
            if (this._state !== 'running' || !this._podId) return;
            try {
                const pod = await this._queryPod(this._podId);
                if (!pod || pod.desiredStatus === 'EXITED' || pod.desiredStatus === 'TERMINATED') {
                    console.log('[RunPod] ⚠️ Spot preempt 감지!');
                    const preemptedId = this._podId;
                    this._state = 'stopped';
                    this._podId = null;
                    this._endpointUrl = null;
                    this._clearState();
                    clearInterval(this._healthTimer);
                    this._healthTimer = null;
                    this.emit('preempted', { podId: preemptedId });
                }
            } catch {}
        }, 30_000);
    }

    /** 마지막 호출 후 idleMinutes 분 지나면 podStop */
    scheduleShutdown(idleMinutes = DEFAULT_IDLE_MINUTES) {
        if (this._idleTimer) clearTimeout(this._idleTimer);
        this._idleTimer = setTimeout(async () => {
            console.log(`[RunPod] ${idleMinutes}분 idle → 자동 종료`);
            await this.stop();
        }, idleMinutes * 60 * 1_000);
    }

    /** 매 RunPod 관련 호출마다 호출해서 idle 타이머 리셋 */
    notifyActivity() {
        if (this._idleTimer) { clearTimeout(this._idleTimer); this._idleTimer = null; }
        if (this._state !== 'running') return;
        let idleMinutes = DEFAULT_IDLE_MINUTES;
        try {
            const s = this._getSecret();
            idleMinutes = (s && s.idleShutdownMinutes) || DEFAULT_IDLE_MINUTES;
        } catch {}
        this.scheduleShutdown(idleMinutes);
    }

    /** 강제 중지 */
    async stop() {
        if (!this._podId || this._state === 'stopped' || this._state === 'stopping') return;

        const podId = this._podId;
        this._state = 'stopping';

        if (this._idleTimer) { clearTimeout(this._idleTimer); this._idleTimer = null; }
        if (this._healthTimer) { clearInterval(this._healthTimer); this._healthTimer = null; }

        console.log(`[RunPod] Pod 종료 중: ${podId}`);
        try {
            await this._graphql(
                `mutation($podId: String!) {
                    podStop(input: { podId: $podId }) {
                        id
                        desiredStatus
                    }
                }`,
                { podId }
            );
            console.log('[RunPod] Pod 종료 완료');
        } catch (e) {
            console.error('[RunPod] Pod 종료 실패:', e.message);
        }

        this._podId = null;
        this._endpointUrl = null;
        this._state = 'stopped';
        this._clearState();
        this.emit('stopped', { podId });
    }

    /** 현재 상태 스냅샷 */
    getStatus() {
        return {
            state: this._state,
            podId: this._podId,
            endpointUrl: this._endpointUrl,
        };
    }
}

PodController._instance = null;

module.exports = { PodController };
