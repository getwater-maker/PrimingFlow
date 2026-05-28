# Phase 1+ 인수인계 메모 (Sonnet 세션용)

> **이 문서를 첫 5분에 읽으면 컨텍스트 100% 복원됩니다.**
>
> 이전 Opus 세션에서 기획·아키텍처·워크플로·Docker 자산을 모두 완료했고, 이제부터는 PrimingFlow 측 코드 구현입니다. 글로벌 규칙(코딩=Sonnet)에 따라 모델이 전환되었습니다.

## 1. 한 줄 요약

PrimingFlow 의 이미지 생성(Google Flow) + 비디오 생성(Grok Imagine) 을 **RunPod ComfyUI 클라우드 GPU** 로 갈아끼우고, "대본 입력 → .vrew 자동 다운로드" **원클릭 자동화 파이프라인** 추가.

## 2. 절대 먼저 읽어야 할 파일

| 파일 | 왜 |
|---|---|
| `C:\Users\Pink-Desktop\.claude\plans\ancient-fluttering-parasol.md` | 승인된 plan 전체. 모든 결정 이력 |
| `rebuild/runpod/README.md` | 이번 세션이 만들 코드의 인터페이스 명세 |
| `rebuild/runpod/workflows/SCHEMA.md` | ComfyUI 워크플로 ↔ provider 슬롯 주입 규약 |
| `rebuild/tts/tts-manager.js` | **이 매니저 패턴을 그대로 복제할 것** |
| `rebuild/tts/providers/gemini-provider.js` | REST provider 의 원본 패턴 |
| `rebuild/tts/secret-store.js` | RunPod 시크릿 저장에 재사용 |
| `rebuild/vrew/vrew-builder.js` (line 589) | `g.videoPath` / `g.imagePath` 가 들어오는 자리 |

## 3. 이번 Opus 세션이 만든 자산 (이미 commit 가능 상태)

```
rebuild/runpod/
├── README.md
├── SETUP_GUIDE.md                          ← 사용자가 단계별로 따라할 RunPod 가입~첫 Pod 가이드
├── HANDOFF_TO_SONNET.md                    ← 이 파일
├── workflows/
│   ├── SCHEMA.md                           ← ★ 워크플로 인터페이스 규약 (코드 작업 시 필독)
│   ├── qwen-image-korean-history.json      ← placeholder 워크플로 (실제 검증 후 교체)
│   ├── qwen-image-korean-history.manifest.json
│   ├── sdxl-lora-ipadapter.json
│   ├── sdxl-lora-ipadapter.manifest.json
│   ├── wan22-i2v-720p.json
│   └── wan22-i2v-720p.manifest.json
├── docker/
│   ├── Dockerfile                          ← ComfyUI + 의존 노드 + 시동 스크립트
│   ├── download-models.py                  ← HF 에서 모델 자동 다운로드 (영상의 HF cache 패턴)
│   ├── extra_model_paths.yaml
│   ├── start.sh
│   └── .dockerignore
└── loras/
    ├── README.md
    └── .gitkeep
```

**placeholder 워크플로 JSON 은 실제 작동 전에 교체 필요.** 절차는 `SETUP_GUIDE.md` 단계 7 이후 "검증" 섹션에 명시. ComfyUI 웹 UI 에서 공식 example 로드 → Save(API Format) → 교체.

## 4. Phase 1~6 구현 순서

### Phase 1 — `pod-controller.js` (★ 가장 먼저)

**위치**: `rebuild/runpod/pod-controller.js`

**의존**: RunPod GraphQL API. base URL = `https://api.runpod.io/graphql`. Bearer token = secret-store 의 `runpod.apiKey`.

**핵심 API**:
- `podFindAndDeployOnDemand` (mutation) — Pod 시동
- `pod` (query) — 상태 조회
- `podStop` (mutation) — 정지

**제공할 함수 시그니처**:
```javascript
class PodController {
    static getInstance() { /* 싱글톤 */ }

    /** Pod 가 살아있으면 endpoint URL 즉시 반환, 아니면 시동 후 ready 까지 대기 */
    async ensureRunning(opts = {}) {
        // 1. secret-store 에서 templateId, gpuTypes, apiKey 읽기
        // 2. 이미 running Pod 가 있으면 endpoint 반환
        // 3. podFindAndDeployOnDemand 호출 (gpuTypes 다중 시도)
        // 4. 60~120초 ready 대기 (8188 포트 healthcheck)
        // 5. https://{POD_ID}-8188.proxy.runpod.net 형태로 반환
        return { endpointUrl, podId };
    }

    /** idle 모니터링 자동 종료 — 마지막 호출 후 idleMinutes 분 지나면 podStop */
    scheduleShutdown(idleMinutes = 5) { }

    /** 매 RunPod API 호출마다 호출해서 idle 타이머 리셋 */
    notifyActivity() { }

    /** 강제 중지 */
    async stop() { }

    /** Spot preempt 감지 — periodic healthcheck 실패 시 status 'preempted' emit */
    on(eventName, callback) { } // 'preempted', 'ready', 'stopped', 'error'
}
```

**시크릿 구조** (secret-store `set('runpod', { ... })`):
```json
{
  "apiKey": "rpa_...",
  "templateId": "abc123xyz",
  "gpuTypes": ["NVIDIA A40", "NVIDIA RTX 4090", "NVIDIA RTX A5000"],
  "cloudType": "COMMUNITY",
  "bidPerGpu": 0.39,
  "idleShutdownMinutes": 5
}
```

**검증**: PrimingFlow UI 에 임시 "🔥 RunPod 테스트 시동" 버튼 → `ensureRunning()` 호출 → 60초 이내 endpoint URL 콘솔 출력 → 그 URL 의 `/8188/queue` GET 호출해서 ComfyUI 응답 받기.

---

### Phase 2 — `image-manager.js` + provider + 시크릿 UI

**위치**:
- `rebuild/image/image-manager.js`
- `rebuild/image/providers/runpod-comfy-provider.js`
- `rebuild/ui/index.html` (시크릿 모달 항목 추가)

**`image-manager.js` 패턴**: `rebuild/tts/tts-manager.js` 와 동일.

**`runpod-comfy-provider.js` 핵심 함수**:
```javascript
async function synth({ prompt, refImagePath, workflowName, width, height, seed, outputPath, onProgress }) {
    // 1. workflows/{workflowName}.json + .manifest.json 로드
    // 2. workflow 깊은 복사 후 매니페스트의 slots 위치에 값 주입 (SCHEMA.md 참고)
    // 3. refImagePath 가 있고 manifest.supports.refImage 면 base64 인코딩해서 images 배열에 추가
    // 4. PodController.getInstance().ensureRunning() 으로 endpoint 확보
    // 5. POST {endpointUrl}/prompt 로 워크플로 제출 → prompt_id 받음
    // 6. WebSocket {endpointUrl}/ws?clientId=... 로 진행률 수신 → onProgress 콜백
    // 7. /history/{prompt_id} 폴링 → 완료 시 결과 이미지 파일명 얻기
    // 8. /view?filename=... 로 결과 다운로드 → outputPath 에 저장
    // 9. PodController.notifyActivity() 호출
    return { path: outputPath, width, height, durationMs, cost };
}
```

> **중요**: RunPod ComfyUI Pod 는 ComfyUI 의 표준 API 를 그대로 노출합니다 (`/prompt`, `/history`, `/view`, `/ws`). Serverless worker-comfyui 와는 호출 방식이 다릅니다. 우리는 Pod 시나리오라 ComfyUI 표준 API 사용.

**UI 변경**:
- `index.html` 시크릿 모달에 RunPod 섹션 추가 (line 4373 의 SecretStore UI 패턴 복제)
- 기존 "이미지 생성" 버튼이 호출하던 `ipcRenderer.invoke('start-generation', ...)` 를 제거하고 `ImageManager.getInstance().synth(...)` 호출로 교체

**검증**: 그룹 1개 → 단일 png 생성 → `outputDir/images/01_*.png` 에 떨어짐.

---

### Phase 3 — `video-manager.js` + provider

**위치**:
- `rebuild/video/video-manager.js`
- `rebuild/video/providers/runpod-comfy-provider.js`

Phase 2 와 90% 동일. 차이점:
- workflow 가 `wan22-i2v-720p.json`
- `refImagePath` 파라미터 대신 `inputImagePath` (i2v 시작 프레임)
- 결과가 mp4 (manifest.output.type === "video")
- ComfyUI `/view` 엔드포인트로 mp4 다운로드 → outputPath 저장
- mp4 메타데이터는 [vrew/vrew-builder.js:600 `readMp4VideoMeta()`](../vrew/vrew-builder.js) 가 알아서 헤더에서 파싱

---

### Phase 4 — `auto-pipeline.js` + 원클릭 UI + 캐시·재시도

**위치**: `rebuild/core/auto-pipeline.js`

**진입점**:
```javascript
async function runFullPipeline({ script, channel, options, onProgress }) {
    // 단계 1: sentence-splitter → sentences[]
    // 단계 2: group-builder → groups[]
    // 단계 3: PodController.ensureRunning() (백그라운드, await 안 함)
    // 단계 4: TTS 병렬 (N=8) — Pod 부팅 중에 진행
    // 단계 5: 한→영 프롬프트 번역 (Qwen 워크플로면 스킵)
    // 단계 6: 이미지 병렬 (N=4)
    // 단계 7: "선택한 클립까지" 비디오 변환 (UI 옵션)
    // 단계 8: vrew-builder.buildVrew(...)
    // 단계 9: PodController.scheduleShutdown(5)
    return { vrewPath, durationMs, totalCost };
}
```

**캐시 구조**: `outputDir/cache/group_{idx}.json`
```json
{ "imagePath": ".../images/01.png", "videoPath": ".../videos/01.mp4", "ttsAudioPath": ".../audio/01.mp3" }
```
재실행 시 캐시 검사 → 있으면 해당 단계 스킵.

**재시도 정책**:
- RunPod API 호출 실패 → 지수 백오프 3회 (1s/4s/16s)
- 3회 후에도 실패 → 비디오는 폴백(이미지만), 이미지는 에러 throw
- `PodController.on('preempted', () => ...)` 핸들러로 5분 대기 후 자동 재시도

**UI**:
- 새 "🚀 원클릭 생성" 버튼 (대본 입력 + 채널 선택 → 클릭)
- 6단계 progress bar 상단 표시
- 단계별 (현재/전체) + 진행률 + 예상 잔여 시간

---

### Phase 5 — Archive

```
git mv rebuild/flow-engine.js       rebuild/_archive/flow-engine.js
git mv rebuild/grok-engine.js       rebuild/_archive/grok-engine.js
git mv rebuild/anti-detect.js       rebuild/_archive/anti-detect.js
git mv rebuild/tts/grok-store.js    rebuild/_archive/grok-store.js
```

`vrew/vrew-builder.js:609` 의 `require('../tts/grok-store')` fallback → 720p 상수로 교체.

`ui/index.html` 에서 archive 된 모듈 require 흔적 제거 (Flow/Grok 관련 IPC 호출 등).

`main.js` 는 난독화로 수정 불가 — IPC 핸들러 호출 안 하면 무해.

검증: `npm start` 후 모든 비기능이 정상 동작 (TTS, 자막 분할, vrew 빌드).

---

### Phase 6 — 비용 모니터링

`rebuild/runpod/usage-tracker.js`:
- Pod 시동 시각·종료 시각 로그
- 일/월 GPU 사용 시간 누적 → `~/.flow-app/runpod-usage.json`
- UI 상단에 "이번 달 사용량: $XX.XX (XX시간)" 표시

---

## 5. 사용자에게 받아야 할 정보 (Phase 1 작업 전 필요)

| 정보 | 받는 방법 |
|---|---|
| RunPod API Key | `SETUP_GUIDE.md` 단계 2 완료 후 사용자가 입력 |
| RunPod Template ID | `SETUP_GUIDE.md` 단계 5 완료 후 사용자가 입력 |
| Docker Hub 이미지 주소 | `SETUP_GUIDE.md` 단계 4 완료 후 사용자가 입력 |
| 워크플로 검증된 JSON | 사용자가 ComfyUI 웹 UI 에서 export 후 교체 |

**현재 상태**: 사용자는 아직 RunPod 가입 전. Phase 1 코드는 사용자 가입 없이도 작성 가능 (시크릿 모달까지). Phase 2+ 의 실제 호출 테스트는 사용자가 SETUP_GUIDE.md 단계 1~5 완료한 후 가능.

**병렬 진행 권장**:
- Sonnet 이 Phase 1 코드 작성 시작
- 동시에 사용자에게 `SETUP_GUIDE.md` 단계 1~5 진행 부탁
- Phase 1 코드 완성 시점에 사용자가 API key·Template ID 준비됨 → 통합 검증

## 6. 자주 빠지는 함정

1. **RunPod Serverless API 와 Pod API 가 다름** — 우리는 Pod 시나리오. Pod 안에서 ComfyUI 가 8188 으로 응답. ComfyUI 표준 API 사용.
2. **proxy URL 형식**: `https://{POD_ID}-8188.proxy.runpod.net` (대시 ID-포트 패턴)
3. **WebSocket 진행률**: ComfyUI 는 `/ws?clientId=...` 로 진행률 push. polling 보다 효율적. 단 `wss://` 사용 필요.
4. **CORS**: Dockerfile 의 `--enable-cors-header` 가 켜져 있어야 함 (이미 설정됨)
5. **Spot preempt**: GraphQL `pod` query 의 `desiredStatus` 가 `EXITED` 로 갑자기 바뀌면 preempt. 5분 대기 후 `podFindAndDeployOnDemand` 재시도.
6. **워크플로 placeholder**: repo 에 commit 된 JSON 은 실제 검증 전 placeholder. SCHEMA.md 의 `_placeholder: true` 가 false 로 바뀌어야 production 사용 가능.
7. **vrew-builder 의 grok-store 의존**: line 609 의 `require('../tts/grok-store')` 는 Phase 5 에서 제거. 그 전까지는 archive 폴더에 grok-store.js 남겨둘 것.

## 7. 검증 체크리스트 (Phase 4 완료 시점)

- [ ] PrimingFlow `npm start` → UI 정상 표시
- [ ] 시크릿 모달에서 RunPod API Key 입력 → "✅ 연결됨"
- [ ] "🔥 테스트 시동" 버튼 → 60초 안에 endpoint URL 응답
- [ ] 3 sentence 짧은 대본 + 원클릭 → 5분 안에 `.vrew` 생성
- [ ] 생성된 .vrew → Vrew 4.0.1 에서 정상 열림 (이미지·비디오·TTS·자막 모두 표시)
- [ ] 5분 idle 후 RunPod 대시보드에서 Pod 가 STOPPED 상태
- [ ] 같은 대본 재실행 → 캐시 히트로 RunPod 호출 0회
- [ ] 작업 중 PrimingFlow 강제 종료 → 재시작 후 미완료 그룹부터 재개

## 8. 시작 명령

새 Sonnet 세션에서:

```
이전 Opus 세션이 만든 plan + 자산을 인계받았습니다.
rebuild/runpod/HANDOFF_TO_SONNET.md 를 읽고 Phase 1 (pod-controller.js) 부터 시작해주세요.
```

이 한 문장이면 모든 컨텍스트 복원됩니다.
