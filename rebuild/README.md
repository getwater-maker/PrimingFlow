# PrimingFlow

한국어 대본을 입력하면 TTS 음성 + 자막을 자동으로 만들고 **Vrew 4.0.1** 호환 `.vrew` 파일로 출력하는 Electron 데스크탑 앱.

## 빠른 시작

### 필요 환경
- **Node.js 18+** (https://nodejs.org — LTS 권장)
- **Git** (https://git-scm.com)

### 설치
```bash
git clone <이-저장소-URL>
cd rebuild
npm install
```

### 실행
```bash
npm start
```

PowerShell/cmd 상관없이 동일.

---

## TTS 백엔드 옵션

| 백엔드 | 별도 설치 | 비용 | 비고 |
|---|---|---|---|
| **VoxCPM2** | conda env `voxcpm` + GPU 필요 | 무료 (로컬) | 메인 — Voice Clone 지원 |
| **Gemini** | API 키 필요 | 무료 quota | 서브 — VoxCPM2 미사용 시 폴백 |

VoxCPM2 는 GPU PC 에서 자동 서버로 동작하고, 같은 LAN 의 다른 PC 는 클라이언트로 자동 연결됩니다.

---

## 출력 .vrew

- **버전**: Vrew **4.0.1** 호환 (3.x .vrew는 4.0에서 안 열리므로 주의)
- **위치**: UI에서 지정한 출력 폴더 (예: `Downloads\상궁\`)

---

## 작업 이어가기 (다른 컴퓨터로 옮길 때)

1. 위 "빠른 시작" 절차로 환경 구축
2. **[CLAUDE.md](./CLAUDE.md) 먼저 읽기** — 이전 작업의 핵심 결정 사항이 정리되어 있음
3. 코드 수정은 주로 `vrew/vrew-builder.js`와 `core/` 디렉토리에서

---

## 디렉토리 한눈에 보기

```
rebuild/
├── main.js                       # Electron 진입점
├── package.json
├── vrew/
│   └── vrew-builder.js           # ★ .vrew 생성 핵심
├── vrew-template.json            # .vrew 베이스 구조
├── core/
│   ├── group-builder.js          # 데이터 모델
│   ├── project-model.js
│   └── long-sentence-splitter/   # 긴 문장 sub-clip 분할
├── flow-engine.js                # 통합 엔진
├── tts/                          # TTS 백엔드들
└── ui/
    └── index.html                # 프론트엔드
```

---

## 라이선스 / 출처
내부 작업용 프로젝트.
