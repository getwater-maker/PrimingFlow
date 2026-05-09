# Supertonic-3 백엔드

PrimingFlow 의 보조 TTS 엔진 — CPU 전용. GPU PC 없이도 음성 합성 가능.
포트 **9882** (OmniVoice 9881 과 분리).

## 1. 처음 한 번 — Python 환경 구성

관리자 PowerShell 에서 (한 번에 복붙):

```powershell
conda create -n Supertonic python=3.11 -y
conda activate Supertonic
pip install -r D:\PrimingFlow\rebuild\tts\supertonic-backend\requirements.txt
python -c "from supertonic import TTS; tts = TTS(auto_download=True); print('voices:', tts.voice_style_names)"
```

마지막 줄이 `voices: ['M1', 'F1', ...]` 처럼 출력되면 성공.
첫 실행 시 모델(~99M)이 자동 다운로드됩니다.

## 2. 자동 시동 등록 (Windows 부팅 시 자동)

관리자 PowerShell:

```powershell
cd D:\PrimingFlow\rebuild\tts\supertonic-backend
PowerShell -ExecutionPolicy Bypass -File .\register-task.ps1
```

성공 메시지 `[Supertonic] 등록 완료.` 가 뜨면 OK.

## 3. 즉시 실행 (테스트)

```powershell
Start-ScheduledTask -TaskName 'Supertonic_Backend'
```

1~2분 후 (모델 메모리 적재 시간):

```powershell
Invoke-WebRequest http://localhost:9882/health
```

`{"status":"ok"...}` 가 뜨면 성공.

## 4. 수동 실행 (디버깅)

```powershell
conda activate Supertonic
python D:\PrimingFlow\rebuild\tts\supertonic-backend\api.py
```

콘솔에 로그가 흐르고 `Uvicorn running on http://0.0.0.0:9882` 가 뜨면 OK.

## 5. PrimingFlow 에서 사용

1. PrimingFlow 실행
2. 프리셋 모달 열기
3. 엔진 칩에서 **Supertonic** 선택
4. Voice 드롭다운에서 M1/F1/M2/F2 중 선택
5. ⭐ 미리듣기로 합성 확인

OmniVoice 가 우선 엔진이며 Supertonic 은 보조(GPU 없이 사용 가능)입니다.

## 끄기 / 제거

```powershell
Stop-ScheduledTask  -TaskName 'Supertonic_Backend'
Unregister-ScheduledTask -TaskName 'Supertonic_Backend' -Confirm:$false
```
