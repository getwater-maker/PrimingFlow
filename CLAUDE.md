# PrimingFlow

## 프로젝트 정체성
유튜브 컨텐츠 자동 제작 도구. 대본 1건 → TTS + 이미지 + .vrew 통합 워크플로.
- 베이스: Electron 앱 (이전 이름 Priming Flow)
- 흡수 대상: Chrome 확장 (Roy's Automator) 의 영리한 부분만 + TTS_Engine 의 OmniVoice

## 🎯 근간 엔진 정책 (사용자 강한 선호)
**OmniVoice 가 PrimingFlow 의 가장 기초/근간 음성변환 엔진**. VoxCPM2/Gemini/msedge 는 보조. 시드 프리셋·UI 칩 순서·새 프리셋 폴백·문서 모두 OmniVoice 첫 자리. 백엔드 다운 시 다른 엔진 자동 fallback 추가하지 말 것 — 사용자가 OmniVoice 를 살리도록 명시 안내가 정책. 자세한 규칙은 메모리 `feedback_omnivoice_primary.md` 참조.

## 사용 흐름 (2026-05 재설계 후)
```
대본 첨부/직접 입력 → 자동 분할 (마침표 기준)
   → 그룹화 (N문장 + 짧은문장 흡수)
   → 긴 문장은 algo-splitter 로 vrewClips 자동 생성 (의미 단위)
   → sentence 인라인 편집 (오타 수정)
   → 그룹별 이미지 생성 (Google Flow)
   → sentence별 TTS 변환 (OmniVoice / Gemini)
   → vrew-builder 로 .vrew 저장
       (한 sentence = 1 TTS, N vrewClips = sourceIn/sourceOut 시간 슬라이스)
```

## 운영 모드 — 출장/집 공통
GPU 컴퓨터(192.168.219.157)는 **Windows 만 켜져있으면 됨**. PrimingFlow Electron 앱은 GPU PC 에서 안 띄워도 OK.
- OmniVoice_Backend 작업 스케줄러가 AtStartup 으로 9881 자동 시동 (SYSTEM 계정)
- 데이터 경로 `D:\PrimingFlow\rebuild\tts\omnivoice-backend\data\` 환경변수 고정 (`FLOW_DICT_PATH`)
- PrimingFlow GUI 는 작업 머신/출장 노트북에서 띄움
  - 집:   `http://192.168.219.157:9881` (LAN)
  - 출장: `http://100.112.7.63:9881` (Tailscale)
  - "집/출장 프리셋" 슬롯에 저장해두고 한 클릭 전환

## 핵심 모듈
- **`flow-engine.js`** — Google Flow Playwright 자동화. `_generateVrew` 는 옛 흐름용
- **`anti-detect.js`** — 휴먼딜레이/쿨다운/일일 한도/가우시안 분포
- **`core/sentence-splitter.js`** — 마침표 기준 문장 분할, 따옴표/MD 헤더 자동 제거
- **`core/group-builder.js`** — N문장 그룹화 + 짧은문장 흡수 + 긴문장 algo-split
- **`core/long-sentence-splitter/algo-splitter.js`** — 쉼표/접속사/어미/관형형 기준 의미 분할
- **`core/long-sentence-splitter/ai-splitter.js`** — Gemini API 분할 (algo 폴백 자동)
- **`core/project-model.js`** — Sentence/Group/Project 클래스
- **`core/channel-store.js`** — 채널 프리셋 (refAudioFolder/outputFolder/profileId/logoPath)
- **`core/ref-audio-scanner.js`** — WAV+TXT 묶음 자동 매칭
- **`tts/tts-manager.js`** — TTS provider 추상화 (OmniVoice 원격 + Gemini)
- **`tts/preset-store.js`** — 음성 프리셋 (~/.flow-app/tts-presets.json)
- **`tts/secret-store.js`** — Gemini API 키 (~/.flow-app/tts-secrets.json)
- **`tts/providers/{omnivoice,gemini}-provider.js`**
- **`tts/omnivoice-backend/api.py`** — FastAPI 백엔드 (포트 9881, GPU 머신에 자동 시동)
- **`vrew/vrew-builder.js`** — sentence + vrewClips → .vrew (TTS≠자막 분리, sourceIn/sourceOut)

## 절대 건드리지 말 것
- **`main.js`** — javascript-obfuscator 로 난독화된 단일 라인. 수정 불가.
  AuthManager 같은 외부 의존은 더미로 우회.
- **`D:\Work\TTS_Engine`** — 읽기 전용. api.py 만 복사해서 사용.
- `_src/` 폴더 (있다면) — 아카이브

## 데이터 모델 핵심
**Sentence**: TTS 단위 (1문장 = 1 음성)
**vrewClips**: 자막 단위 (긴 문장은 N개로 분할). 같은 sentence 의 vrewClips 는 같은 dub mp3 를 sourceIn/sourceOut 으로 시간 슬라이스 → 음성은 자연스럽고 자막은 N번 바뀜
**Group**: N개 sentences. 그룹별로 Flow 이미지 1장. 그룹 안 모든 vrewClip 이 같은 이미지 공유 → 그룹 단위 Ken Burns

## TTS Provider (2종 — OmniVoice 근간 + Gemini 보조)
| Provider | 비용 | 키 | 한국어 | 용도 |
|---|---|---|---|---|
| **OmniVoice** | 무료 (GPU 서버) | 불필요 | Voice Clone + Voice Design | **근간 엔진** — 주력 |
| Gemini | 무료 quota | API 키 | 좋음 (30 voices) | 보조 / 백업 |

## 인증 상태
- adwise.co.kr 권한 검증 완전 제거 (auth-manager.js 가 더미)
- 단독 사용 모드

## 작업 규칙
- 모든 변경은 D:\PrimingFlow 안에서만
- 외부 서버 통신 추가 금지 (단독 사용 원칙)
- 영구 무료 옵션 우선 검토
- **main process 코드 (flow-engine.js, tts/*) 변경 시 앱 재시작 필요** (Ctrl+R 만으로는 반영 X)
- UI (index.html) 변경은 Ctrl+R 로 반영

## 모델 분담
- 기획·아키텍처·이식 계획서 → Opus
- 코드 작성·디버깅·테스트 → Sonnet

## 빌드 / 실행
- 개발: `cd D:\PrimingFlow && npm start`
- 인스톨러: `cd D:\PrimingFlow && npm run dist` → dist/Flow_Studio_Setup.exe
- OmniVoice 의존: conda env `D:/miniconda3/envs/OmniVoice/python.exe` (api.py 자동 spawn)

## 알려진 한계
- **Flow 미디어 설정 클릭** — Google UI 변경에 따라 selector 가 안 맞을 수 있음. 로그 dump 로 진단.
- **Electron file.path** — `<input type="file">` 에서 빈 문자열인 경우 fileName 만 저장됨. 채널 등록으로 우회.
- **로그인 자동화 미구현** — 이미지 생성 전 "선택한 계정으로 로그인" 사전 클릭 필수.
