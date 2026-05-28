# `rebuild/runpod/` — RunPod 클라우드 GPU 통합 자산

PrimingFlow 의 이미지/비디오 생성을 Google Flow / Grok 에서 **오픈소스 모델 + RunPod ComfyUI** 로 갈아끼우기 위한 자산 모음.

상위 plan: `C:\Users\Pink-Desktop\.claude\plans\ancient-fluttering-parasol.md`

## 디렉토리 역할

```
rebuild/runpod/
├── README.md                  ← 이 파일 (전체 구조 + Sonnet 세션용 인터페이스 명세)
├── SETUP_GUIDE.md             ← 사용자(컴맹)용 단계별 가이드
├── HANDOFF_TO_SONNET.md       ← Phase 1+ 코드 구현 세션 시작 시 첫 5분에 읽을 컨텍스트
├── workflows/
│   ├── SCHEMA.md              ← 워크플로 JSON 이 노출해야 할 API 인터페이스 (필수)
│   ├── qwen-image-korean-history.json    ← 이미지 1순위 (Qwen-Image, 한국어 프롬프트 직접)
│   ├── sdxl-lora-ipadapter.json          ← 이미지 2순위 (SDXL + 한국사 LoRA + 캐릭터 참조)
│   └── wan22-i2v-720p.json               ← 비디오 (Wan2.2-I2V-A14B)
├── docker/
│   ├── Dockerfile             ← ComfyUI base + 의존 노드 + 모델 다운로드 스크립트
│   ├── download-models.py     ← 첫 부팅 시 HF 에서 모델 캐싱
│   ├── extra_model_paths.yaml ← HF cache 경로를 ComfyUI 가 인식하도록 매핑
│   └── start.sh               ← Pod 시작 시 ComfyUI 8188 포트 시동
└── loras/                     ← Civitai 한국사 LoRA .safetensors 보관 (사용자가 다운로드)
    ├── README.md              ← LoRA 추가 방법
    └── .gitkeep
```

## PrimingFlow ↔ RunPod 통신 흐름

```
[Electron 렌더러]
   require('../image/image-manager')
        ↓ synth({prompt, refImagePath, outputPath})
[ImageManager]
   ├ runpod-comfy-provider.js
   │    workflow JSON 로드
   │    SCHEMA.md 가 정의한 슬롯에 prompt/refImage/seed 주입
   ↓ POST https://api.runpod.io/v2/{endpointId}/runsync
[RunPod Worker (Docker 컨테이너)]
   └ start.sh → ComfyUI 8188 → 워크플로 실행 → base64 결과 응답
       ↓
[Electron 렌더러]
   ← base64 decode → outputPath 에 저장
   → groups[].imagePath 채움
```

비디오도 동일 패턴. 다른 점은 **워크플로 JSON 만 다름** + **응답이 mp4 base64**.

## Sonnet 세션이 알아야 할 핵심 인터페이스

Phase 1+ 코드 구현 시 다음 인터페이스를 그대로 따른다.

### `image-manager.js` (= `tts-manager.js` 패턴 복제)
```javascript
const ImageManager = require('./image/image-manager');

const result = await ImageManager.getInstance().synth({
    prompt: '조선시대 왕이 경복궁에서 회의하는 장면',
    refImagePath: null,            // 옵션: 캐릭터 참조 이미지 절대경로
    workflowName: 'qwen-image-korean-history',  // workflows/{name}.json
    width: 1280,
    height: 720,
    seed: -1,                      // -1 = 랜덤
    outputPath: 'D:/.../images/01_xxx.png',
    onProgress: (p) => {},         // 0~1
});
// result: { path, width, height, durationMs, cost }
```

### `video-manager.js`
```javascript
const result = await VideoManager.getInstance().synth({
    refImagePath: '.../images/01_xxx.png',  // i2v 입력
    motionPrompt: 'gentle camera push-in',
    workflowName: 'wan22-i2v-720p',
    durationSec: 5,
    outputPath: 'D:/.../videos/01_xxx.mp4',
    onProgress: (p) => {},
});
// result: { path, width, height, durationSec, cost }
```

### `pod-controller.js` (신규 핵심)
- RunPod GraphQL `podFindAndDeployOnDemand` 로 Pod 시동
- Spot preempt 감지 (`/v2/.../health` polling) + 5분 후 재시동
- `scheduleShutdown(idleMinutes=5)` — 마지막 호출 후 N분 idle 시 자동 종료
- API key 는 `secret-store.set('runpod', { apiKey })`

## 비용 추정 (확정 사용 패턴 기준)

- 사용자 사용량: 하루 7편, 월 200편
- GPU: A40 48GB (이미지+비디오 동시 처리) — RunPod Spot $0.39/h
- 영상 1편 GPU 시간: 이미지 30 × 8s + 비디오 30 × 130s = ~70분
- 월 GPU 사용: 200편 × 70분 = 230시간 → **약 $90/월**
- 추가 비용 없음 (네트워크 볼륨 X, egress 무료)

## 라이선스

- **Qwen-Image**: Apache 2.0 (상업 사용 OK)
- **SDXL**: OpenRAIL-M (상업 사용 OK, 폭력/성인물 금지)
- **Wan2.2-I2V**: Apache 2.0 (상업 사용 OK)
- **Civitai LoRA**: 각 LoRA 페이지의 라이선스 확인 (대부분 CreativeML OpenRAIL-M)

수익화 안전. FLUX.1-dev 는 non-commercial 이라 본 프로젝트에서 제외.
