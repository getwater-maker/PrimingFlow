# PrimingFlow — 작업 컨텍스트 노트

> 이 문서는 다음 AI(또는 사람)가 작업을 이어갈 때 **5분 안에 컨텍스트를 복원**하기 위한 노트입니다.

## 프로젝트 한 줄 요약
한국어 대본 → TTS 음성 + 자막 → **Vrew 4.0.1 호환 .vrew(ZIP) 파일** 자동 생성하는 Electron 앱.

## 실행
```powershell
cd D:\PrimingFlow\rebuild
npm install   # 첫 실행 시
npm start     # → electron .
```

## 디렉토리 구조 (핵심만)
- `vrew/vrew-builder.js` — **.vrew 파일 생성 핵심 모듈** (가장 자주 수정)
- `vrew-template.json` — .vrew 베이스 구조
- `dummy-tts.mp3` — (현재 미사용 — 4.0 호환 작업 후 단일 ttsClip 사용으로 폐기)
- `core/long-sentence-splitter/algo-splitter.js` — 긴 문장 sub-clip 분할 (`splitLongSentenceAlgo`)
- `core/group-builder.js` — sentence/group 데이터 모델 빌더
- `flow-engine.js` — 통합 엔진 (137KB, 옛 코드 포함, 일부는 미사용)
- `tts/` — TTS 백엔드 (OmniVoice 원격 + Gemini)
- `ui/index.html` — 프론트엔드 (vrew-builder를 require해서 호출)

## 결정적 작업 기록 (2026-05-03)

### 🔥 Vrew 4.0.1 호환을 위한 .vrew 형식 대전환

**배경**: Vrew가 자동 업데이트로 3.x → 4.0.1 메이저 버전 업 → 기존 PrimingFlow .vrew(이중 트랙 형식)가 "원인을 알 수 없는 오류" 화면으로 안 열림.

**검증 기준**: 사용자가 Vrew 4.0.1에서 직접 만든 두 .vrew를 분석:
- `D:\PrimingFlow\test.vrew` (빈 프로젝트, ttsClip 1개)
- `D:\PrimingFlow\01.vrew` (외부 wav 음성분석)

#### 적용한 4.0.1 호환 변경 (vrew-builder.js)

| # | 항목 | 3.x (옛) | 4.0.1 (현재) |
|---|---|---|---|
| 1 | clip 식별자 | `clipId` | **`id`** |
| 2 | caption 모드 | (없음) | **`captionMode: "MANUAL"`** 필수 |
| 3 | comment | `"3.8.0\t..."` | **`"4.0.1\t..."`** |
| 4 | saveInfo.version | `"3.8.0"` | **`"4.0.1"`** |
| 5 | clip.assetIds | `[img, tts, dub]` | **`[]` 빈 배열** |
| 6 | clip.words | `[]` 빈 배열 | **type 7 시작 마커 + type 2 종료 마커** 필수 |
| 7 | 시작 마커 assetIds | (없음) | **이미지 + 오디오 asset 모두 연결** |
| 8 | 트랙 구조 | ttsClip + ttsDubbing 이중 | **단일 ttsClip** |
| 9 | sourceFileType | TTS + TTS_DUBBING | **TTS** 단일 |
| 10 | dummy-tts.mp3 | 사용 | **사용 안 함** (음성을 ttsClip이 직접 가리킴) |
| 11 | ttsClipInfosMap | (단일 항목 또는 vrewClip별) | **sentence별 1 항목 (speaker 포함)** |
| 12 | 긴 문장 분할 | sentence.vrewClips 입력 의존 | **자동 호출** (`splitLongSentenceAlgo(text, 20)`) |

#### 시도했다가 폐기한 방향
- **단순 `videoAudio` 트랙**: Vrew에서 "오디오"로 표시되고 화자 이름 안 보임 → ttsClip 단일로 회귀
- **이중 트랙 (ttsClip dummy + ttsDubbing 실제)**: dummy mp3를 메인 음성으로 인식 → 빈 클립 표시 → 단일 ttsClip 직접 가리키기로 변경

### 🎤 화자 정보
기본값 `butter_f / characteristic2 / v4` (Vrew 기본 한국어 여성). `vrew-builder.js`의 `DEFAULT_SPEAKER` 상수에 정의.

### 🎬 켄번스 효과
이미지 트랙에 `kenburnsAnimationInfo: {type: 'custom', from, to}` 형식. `KEN_BURNS_PATTERNS` 5개 패턴 순환.

## 백업 파일들 (참고용)
- `vrew/vrew-builder.js.backup_20260503_082456` — 옛 이중 트랙 (4.0 비호환, 폐기)
- `vrew/vrew-builder.js.simple_v40_*` — 단일 videoAudio 시도 (음성 정상이나 화자 표시 X, 폐기)

## OmniVoice 통합 (2026-05-07 단순화 후)

### 구조 (TTS 엔진 = OmniVoice 근간 + Gemini 보조)
- `tts/omnivoice-backend/api.py` — FastAPI 서버 (포트 9881). `/upload-ref-audio` (합성용 토큰), `/dict` (사전 LAN 공유), `/tts` (합성)
- `tts/providers/omnivoice-provider.js` — `cfgValue→guidance_scale`, `inferenceTimesteps→num_step`, speed 네이티브
- `tts/tts-manager.js` — OmniVoice (원격 only) + Gemini 두 가지만
- `tts/tts-config.js` — `{ omnivoice: { baseUrl: '...' } }` (mode 필드 폐지)
- `tts/network-bootstrap.js` — UDP v2 디스커버리 (OmniVoice 단일)
- `tts/preset-store.js` — OmniVoice 2 + Gemini 2 시드. loadAll 에 voxcpm/msedge/azure 자동 폐기 + OmniVoice 우선화
- `ui/index.html` — 엔진 칩 (OmniVoice / Gemini), 참조음성은 폴더 기반만, 서버모달은 OmniVoice URL 1개

### 포트 배정
| 서비스 | 포트 |
|--------|------|
| OmniVoice | 9881 |
| UDP 디스커버리 | 9893 |

### 설치 상태
- `D:\miniconda3\envs\OmniVoice\python.exe` 존재
- omnivoice 0.1.2 일반 설치

### 자동기동 (GPU 서버 PC, 1회 등록)
```powershell
cd D:\PrimingFlow\rebuild\tts\omnivoice-backend
PowerShell -ExecutionPolicy Bypass -File .\firewall-allow.ps1
PowerShell -ExecutionPolicy Bypass -File .\register-task.ps1
Start-ScheduledTask -TaskName "OmniVoice_Backend"
```
이후 GPU PC 켜져있기만 하면 부팅 시 자동 시동. 데이터는 `D:\PrimingFlow\rebuild\tts\omnivoice-backend\data\` 환경변수 고정.

## 근간 엔진 정책 (2026-05-07)

**OmniVoice 가 PrimingFlow 의 근간 엔진**. 시드 프리셋(`preset-store.js`)도 OmniVoice clone 이 isDefault:true. loadAll 에 isDefault 가 없을 때 OmniVoice 우선화 자동 마이그레이션 포함. 새 TTS 흐름 추가 시 OmniVoice 우선 검증.

## 미해결/다음 작업

1. **자막 sub-clip 분할 검증**: `splitLongSentenceAlgo(text, 20)` 자동 호출 추가됨 → 긴 문장이 Vrew에서 sub-clip으로 분할 표시되는지 확인 필요
2. **vrew-builder.js의 dummy-tts.mp3 require**: 현재 미사용이지만 코드 상단에 변수만 남아있음 → 정리 가능

## 디버깅 팁
- 로그에 `[Vrew] (4.0.1 호환)` 표시 보이면 새 코드 동작 중
- `.vrew.debug.json` 파일이 옆에 자동 생성됨 → project.json 내용 확인 가능
- Vrew 4.0.1에서 안 열리면 `.vrew` 압축 풀어 `project.json`을 사용자가 만든 `test.vrew`/`01.vrew`와 라인 단위 비교

## 자료
- Vrew 4.0.1 자체 .vrew 형식: `D:\PrimingFlow\test.vrew`, `D:\PrimingFlow\01.vrew` (.gitignore 제외)
- 검증된 형식 = 위 파일들의 `project.json` 구조
