# OmniVoice TTS Backend

PrimingFlow 의 OmniVoice TTS FastAPI 서버 (포트 9881).

## 사전 조건

1. **NVIDIA GPU** (CUDA 12+)
2. **conda 환경** `OmniVoice` 에 omnivoice 패키지 설치

```powershell
# OmniVoice 패키지가 이미 설치된 환경 확인
D:\miniconda3\envs\OmniVoice\python.exe -m pip show omnivoice
```

## 처음 실행 (개발/테스트)

```bat
start.bat
```

- 첫 실행 시 모델 자동 다운로드 (k2-fsa/OmniVoice, 수 분 소요)
- `http://localhost:9881/health` 가 200 을 반환하면 준비 완료

## 자동기동 등록 (GPU 서버 PC)

관리자 PowerShell 에서 한 번 실행:

```powershell
# 1) 방화벽 인바운드 허용
PowerShell -ExecutionPolicy Bypass -File .\firewall-allow.ps1

# 2) 작업 스케줄러 등록 (부팅 시 자동 시작)
PowerShell -ExecutionPolicy Bypass -File .\register-task.ps1

# 3) 즉시 테스트 실행
Start-ScheduledTask -TaskName "OmniVoice_Backend"

# 4) 헬스 체크 (1~2분 후)
Invoke-WebRequest http://localhost:9881/health
```

## API 엔드포인트

| Method | Path | 설명 |
|--------|------|------|
| GET | /health | 모델 로드 완료 시 200, 로딩 중 503 |
| POST | /upload-ref-audio | 참조음성 파일 업로드 → token 반환 |
| POST | /tts | 단일 TTS 합성 (WAV 바이트 반환) |
| POST | /tts-batch | 배치 합성 (base64 JSON 반환) |
| POST | /tts-batch-save | 배치 합성 + 디스크 직접 저장 |
| POST | /asr | 음성 → 텍스트 (Whisper) |

## 포트 충돌 없음

| 서비스 | 포트 |
|--------|------|
| VoxCPM2 | 9892 |
| OmniVoice | **9881** |
| UDP 디스커버리 | 9893 |

## 로그

`logs/omnivoice_YYYYMMDD_HHMM.log` 에 자동 저장.
