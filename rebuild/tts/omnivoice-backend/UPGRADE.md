# OmniVoice 업데이트 절차

OmniVoice 패키지 (`omnivoice` PyPI) 를 새 버전으로 올리는 방법.
GPU PC (집: 192.168.219.157, 출장: 100.112.7.63) 에서만 작업하면 됩니다.
PrimingFlow Electron 앱은 영향 없음 — api.py 가 `from_pretrained` 만 호출하므로 0.1.x 마이너 업그레이드는 호환 보장.

## 한 번에 따라하기 (GPU PC, 관리자 PowerShell)

> ⚠️ **반드시 "관리자 권한" PowerShell 에서 실행하세요.**
> 시작 메뉴 → "PowerShell" 검색 → 마우스 우클릭 → **"관리자 권한으로 실행"**.
> 창 제목 표시줄에 "관리자:" 라고 보여야 작업 스케줄러를 stop/start 할 수 있습니다.
> 일반 권한이면 `Start-ScheduledTask : Access is denied.` 에러 → 백엔드 재시작 실패 → 패키지 업그레이드가 메모리에 반영되지 않습니다.

```powershell
# 1) 백엔드 중지 (실행 중이면)
Stop-ScheduledTask -TaskName 'OmniVoice_Backend' -ErrorAction SilentlyContinue

# 2) conda env 활성화
conda activate OmniVoice

# 3) 패키지 업그레이드 (PyTorch 호환 마진 있어 일반적으로 그대로 깔림)
pip install -U omnivoice

# 4) 0.1.4부터 오디오 백엔드 의존성 변경 — 안전하게 추가 설치
pip install -U soundfile librosa

# 5) import 점검 (실패하면 출력 메시지 따라 누락 모듈 추가 설치)
python -c "from omnivoice import OmniVoice; print('omnivoice import OK')"

# 6) 백엔드 재시작
Start-ScheduledTask -TaskName 'OmniVoice_Backend'

# 7) 1~2분 후 헬스체크 (모델 메모리 적재 대기)
Start-Sleep -Seconds 90
Invoke-WebRequest http://localhost:9881/health
```

`{"status":"ok"...}` 가 뜨면 업그레이드 성공.

## 가장 쉬운 대안 — GPU PC 재부팅

위 PowerShell 명령이 번거롭거나 권한 문제가 발생하면 **GPU PC 를 재부팅**하면 깔끔합니다.
작업 스케줄러가 `AtStartup` 트리거라 부팅 시 자동으로 새 버전으로 시동됩니다.

```
시작 → 전원 → 다시 시작
```

재부팅 후 1~2분 대기 → PrimingFlow 사용. 끝.

## 만약 업그레이드 후 동작 안 하면 (롤백)

```powershell
Stop-ScheduledTask -TaskName 'OmniVoice_Backend'
conda activate OmniVoice
pip install "omnivoice==0.1.2"   # 또는 직전 버전 번호
Start-ScheduledTask -TaskName 'OmniVoice_Backend'
```

이전 버전 번호는 `pip index versions omnivoice` 또는 [PyPI history](https://pypi.org/project/omnivoice/#history) 에서 확인.

## 업데이트 알림 받기

새 버전이 나왔는지 가끔 확인하는 명령:

```powershell
conda activate OmniVoice
pip index versions omnivoice
```

또는 [PyPI 페이지](https://pypi.org/project/omnivoice/) 를 즐겨찾기.

## 모델 가중치 자체를 강제 재다운로드 (드물게 필요)

HF 의 `k2-fsa/OmniVoice` 가중치 자체가 갱신된 경우:

```powershell
Stop-ScheduledTask -TaskName 'OmniVoice_Backend'
# HF 캐시는 D:\huggingface_cache (start-autorun.bat 환경변수)
Remove-Item "D:\huggingface_cache\hub\models--k2-fsa--OmniVoice" -Recurse -Force
Start-ScheduledTask -TaskName 'OmniVoice_Backend'
# 첫 시동 때 자동 재다운로드 (~2GB, 5~10분 소요)
```

다 받으면 자동 등록 + 정상 동작.

## 빠른 진단 — 무엇이 잘못됐을 때 어디 보는지

| 증상 | 원인 후보 | 확인 방법 |
|---|---|---|
| /health 가 503 (loading) | 모델 로딩 중 또는 실패 | `Get-ChildItem D:\PrimingFlow\rebuild\tts\omnivoice-backend\logs \| Sort LastWriteTime -Desc \| Select -First 1 \| Get-Content -Tail 40` |
| /health 가 연결 거부 | 작업 스케줄러 미시동 | `Get-ScheduledTaskInfo -TaskName 'OmniVoice_Backend'` 의 LastTaskResult |
| import 에러 | 의존성 누락 | `python -c "from omnivoice import OmniVoice"` 실행 후 traceback 따라 `pip install ...` |
| TTS 호출 시 PrimingFlow 에서 실패 | API 키 인증 / 네트워크 | start-autorun.bat 의 FLOW_API_KEY 와 PrimingFlow 의 키가 같은지 확인 |
