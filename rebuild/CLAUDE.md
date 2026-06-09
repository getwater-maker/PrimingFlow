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

## 2026-06 아키텍처 업데이트 (이미지·영상·안티디텍션·로컬 렌더)
> v1.13.83~92에서 추가/변경된 핵심. 다음 작업 전에 반드시 숙지.

### 이미지 생성 — 진입점 4개가 모두 같은 경로로 수렴
- 버튼: **빈그룹 / 선택 / 범위** + **자동제작(generateAll)** → 전부 `_runRunPodImageGeneration()` (ui/index.html) 로 수렴.
- 모델 분기(`#runpodImageModel`): **Flow**(브라우저 자동화, flow-engine.js via `start-generation` IPC) / **Nano Banana 2 = Gemini**(image/image-manager.js, API) / **Genspark**(genspark-engine.js, 브라우저).
- 카운트 갱신: 이미지 1장 완료 시 `_setGroupImageThumbnail` → `_refreshProgPanel` (제작 진행률 🖼 N/M 실시간).

### Genspark (genspark-engine.js)
- 배치 6장(`batchSize`, load 에서 6 clamp). 설정값은 `~/.flow-app/genspark-config.json` (`imageSize` 기본 '1K', `ratio` '16:9'; ratio 는 프로젝트 aspect 로 override → 쇼츠 9:16).
- **클릭은 절대좌표가 아니라 DOM 텍스트(`hasText`)** 로 "1K"/"16:9" 옵션을 찾아 누름. → 무엇을 누를지는 그 PC 의 config 값이 결정 (PC 마다 config 파일 별도).
- `_applySettings` 가 **팝오버 안에서 바로 검증**하고 결과 반환(배치당 팝오버 1회). 1K/16:9 확인 안 되면 최대 3회 재적용, 끝내 실패 시 그 배치 생성 안 함(미스매치 차단).
- "5시간 제한" 등 한도 메시지 감지 → 해당 배치 실패 처리. 휴먼 페이싱(첫 배치 후 긴 대기 + 점증 대기).

### 영상 생성 — 엔진 2종, 공통 인터페이스
- `grok-engine.js`(무료, X 로그인) · `flow-veo-engine.js`(유료 Veo). 공통 계약: `generateVideoFromImage({imagePath,prompt,outputPath,abortSignal})` + `_aspectRatio`.
- 선택: `#videoEngineSelect` / localStorage `pf_video_engine` / `_getVideoEngine()`.
- **Grok 720p 한도**: 빨간 계기판 = `svg.lucide-gauge` + 부모 `text-fg-danger` + `aria-label`("…720p…한도에 도달"). **이미지 첨부 후에만** 뜨므로 `_check720pLimit()` 를 **이미지 업로드 직후** 호출 → 한도면 480p 선제 전환(칩은 비활성 안 되니 칩-disable 감지로는 못 잡음). 생성 중 480p 강등 토스트 감지는 안전망.

### Flow 안티디텍션 / 계정 보호 (flow-engine.js + anti-detect.js)
- **계정당 하루 한도 `PER_PROFILE_DAILY_CAP=45` (성공 이미지 기준)**. anti-detect-state.json `profiles{프로필:성공수}` (날짜=PC 로컬 자정 기준). 도달 시 `flow-rate-exhausted` 신호로 다음 프로필 폴백(계정 휴식).
- 성공 카운트는 `_saveImage` 성공 시 `antiDetect.registerGenerationSuccess()` (시도 아님). 글로벌 todayCount(시도) 경고는 별개 유지.
- **클릭 가로채는 팝업 자동 닫기** `_dismissBlockingOverlay()` (Radix `[data-state=open][aria-hidden=true]` 오버레이 → Escape/닫기버튼/pointer-events 무력화 + force 클릭). 입력창 클릭 2곳 + `_dismissBanners`(세션 시작)에 적용 → 계정 멀쩡한데 팝업에 막혀 "차단"으로 오인되던 케이스 복구.
- "비정상 활동 감지" → 즉시 폴백. 프로필 6개마다 적극적 순차 전환.
- UI: **📊 계정별 오늘 이미지** 버튼(`showAccountImageCounts`) — anti-detect-state.json 읽어 계정별 성공 장수 표시.

### 로컬 mp4 렌더 (Vrew 없이 완성본) — core/video-renderer.js
- `buildVideoMp4({sentences,groups,outPath,opts})`: **ffmpeg-static** 사용. `opts.aspect` 로 16:9(1920×1080)/**9:16(1080×1920)** 지원. 컷별 스틸을 TTS 길이만큼 + **켄번스(zoompan)** + **ASS 자막 번인(한글: 번들 Pretendard + malgun 폴백)** + 오디오 concat→AAC + `-shortest +faststart`.
- ffmpeg 경로/프로브: `core/media-utils.js` `getFfmpegPath()`(asar-unpacked 보정) `getMediaInfo()`. UI: `saveVideoMp4()` ↔ **📹 mp4 로 렌더** 버튼(이미 `aspect:_projectAspect()` 전달 → 쇼츠도 세로 mp4, 단 전체 1개 파일).
- **쇼츠 편별(shortsNum) 분리 렌더는 미구현(설계만)** — buildVideoMp4 를 편별 N회 호출하는 래퍼 + provider seam 으로 확장 가능.

### 내보내기(이미지 프롬프트 요청서) — `_buildPromptRequestText` (ui/index.html)
- 맨 위: 스타일 + **사전설정(presetPrompt = 사용자 입력값, 코드 하드코딩 아님)** + 규칙들.
- 규칙: **🕰 시대·배경 명시(필수)** — 대본 맥락에서 시대를 AI 가 스스로 판단해 모든 프롬프트에 일관 명시(사전설정 비워도 시대 규칙이 대체). + 🛡 안전필터 회피 + 🛡 유튜브 수익화 안전.

### 스타일 — core/style-store.js
- BUILT_IN_STYLES(코드 시드, 수정/삭제 불가) + 사용자 styles.json. **기본 이미지 스타일 = `disney`(디즈니/픽사)** (styleSelect·scriptCopyStyleSelect 폴백). disney 프롬프트 = "A cute warm 3D-animated illustration … Pixar/Disney-like warmth".

### 프로젝트 저장/복원
- **`.pflow`** (`~/.flow-app/projects/<대본명>.pflow`) = 무손실 복원(그룹·문장·이미지·TTS·프롬프트). 자동저장(변경 시 + 2분 주기) + "💾 저장됨" 클릭 즉시저장 + **📂 불러오기**(loadProjectFile). `.md` 재오픈 시 저장된 imagePrompt/videoPrompt 자동 복원.
- `.vrew` 는 **내보내기 전용**(Vrew 편집용). 되돌려 작업목록 재구성은 손실 → 복원은 `.pflow` 가 정석.

### 버전/배포
- 버전은 **rebuild/package.json 한 곳**. `npm run dist` 가 GitHub publish 포함. 현재 v1.13.92. main process(flow-engine/anti-detect/genspark-engine/grok-engine/video-renderer 등) 변경은 **앱 완전 재시작** 필요(Ctrl+R 불가); ui/index.html 은 Ctrl+R 반영.

## 디버깅 팁
- 로그에 `[Vrew] (4.0.1 호환)` 표시 보이면 새 코드 동작 중
- `.vrew.debug.json` 파일이 옆에 자동 생성됨 → project.json 내용 확인 가능
- Vrew 4.0.1에서 안 열리면 `.vrew` 압축 풀어 `project.json`을 사용자가 만든 `test.vrew`/`01.vrew`와 라인 단위 비교

## 자료
- Vrew 4.0.1 자체 .vrew 형식: `D:\PrimingFlow\test.vrew`, `D:\PrimingFlow\01.vrew` (.gitignore 제외)
- 검증된 형식 = 위 파일들의 `project.json` 구조
