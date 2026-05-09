# Supertonic-3 업데이트 절차

`supertonic` PyPI 패키지를 새 버전으로 올리는 방법.
**PrimingFlow 가 떠있는 같은 PC** 에서 작업합니다 (Supertonic 은 로컬 CPU 백엔드).
PrimingFlow Electron 앱은 영향 없음 — `api.py` 가 라이브러리 표준 API (`TTS(auto_download=True)` / `synthesize`) 만 호출하므로 1.x 마이너 업그레이드는 호환 보장.

## 한 번에 따라하기

> ⚠️ **반드시 "관리자 권한" PowerShell 에서 실행하세요.**
> 시작 메뉴 → "PowerShell" 검색 → 마우스 우클릭 → **"관리자 권한으로 실행"**.
> 창 제목 표시줄에 "관리자:" 라고 보여야 작업 스케줄러를 stop/start 할 수 있습니다.
> 일반 권한이면 `Start-ScheduledTask : Access is denied.` 에러 → 백엔드 재시작 실패 → 패키지 업그레이드가 메모리에 반영되지 않습니다.

```powershell
# 1) 백엔드 중지 (실행 중이면)
Stop-ScheduledTask -TaskName 'Supertonic_Backend' -ErrorAction SilentlyContinue

# 2) conda env 활성화
conda activate Supertonic

# 3) 패키지 업그레이드
pip install -U supertonic

# 4) 의존성 함께 갱신 (PyPI 가 마이너 패치를 동반 요구할 수 있음)
pip install -U onnxruntime soundfile huggingface-hub

# 5) import 점검 (실패하면 출력 메시지 따라 누락 모듈 추가 설치)
python -c "from supertonic import TTS; tts = TTS(auto_download=True); print('voices:', tts.voice_style_names)"

# 6) 백엔드 재시작
Start-ScheduledTask -TaskName 'Supertonic_Backend'

# 7) 1~2분 후 헬스체크
Start-Sleep -Seconds 90
Invoke-WebRequest http://localhost:9882/health -UseBasicParsing
```

`{"status":"ok",...}` 가 뜨면 업그레이드 성공. PrimingFlow 의 슈퍼톤 프리셋 자물쇠가 자동 풀립니다 (v1.10.4+ 의 polling 자동 재연결).

## 가장 쉬운 대안 — PC 재부팅

위 PowerShell 명령이 번거로우면 **PC 를 재부팅**하면 깔끔합니다.
작업 스케줄러가 `AtStartup` 트리거라 부팅 시 자동으로 새 버전으로 시동됩니다.

```
시작 → 전원 → 다시 시작
```

재부팅 후 PrimingFlow 켜기. 끝.

## 만약 업그레이드 후 동작 안 하면 (롤백)

```powershell
Stop-ScheduledTask -TaskName 'Supertonic_Backend'
conda activate Supertonic
pip install "supertonic==1.2.0"   # 또는 직전 버전 번호
Start-ScheduledTask -TaskName 'Supertonic_Backend'
```

이전 버전 번호는 `pip index versions supertonic` 또는 [PyPI history](https://pypi.org/project/supertonic/#history) 에서 확인.

## 업데이트 알림 받기

새 버전이 나왔는지 가끔 확인하는 명령:

```powershell
conda activate Supertonic
pip index versions supertonic
```

또는 [PyPI 페이지](https://pypi.org/project/supertonic/) 즐겨찾기.

## 모델 가중치 자체를 강제 재다운로드 (드물게 필요)

HF 의 `Supertone/supertonic-3` 가중치 자체가 갱신된 경우:

```powershell
Stop-ScheduledTask -TaskName 'Supertonic_Backend'
# HF 캐시는 D:\huggingface_cache (start-autorun.bat 환경변수)
Remove-Item "D:\huggingface_cache\hub\models--Supertone--supertonic-3" -Recurse -Force
Start-ScheduledTask -TaskName 'Supertonic_Backend'
# 첫 시동 때 자동 재다운로드 (~99M, 30초~1분 소요)
```

다 받으면 자동 등록 + 정상 동작.

## 새 voice 추가됐는지 확인

업그레이드 후 voice 가 바뀌었으면:

```powershell
conda activate Supertonic
python -c "from supertonic import TTS; tts = TTS(auto_download=True); print(tts.voice_style_names)"
```

새 이름(예: M6, F6) 이 보이면 PrimingFlow 의 supertonic-provider.js 의 `FALLBACK_VOICES` 도 업데이트 필요. 그러나 정상적으로는 백엔드 init 시 `/voices` 가 새 목록을 받아 자동 캐시하므로 코드 변경 없이 UI 에 반영됩니다.

## 빠른 진단 — 무엇이 잘못됐을 때 어디 보는지

| 증상 | 원인 후보 | 확인 방법 |
|---|---|---|
| `/health` 가 503 (loading) | 모델 로딩 중 또는 실패 | `Get-ChildItem D:\PrimingFlow\rebuild\tts\supertonic-backend\logs \| Sort LastWriteTime -Desc \| Select -First 1 \| Get-Content -Tail 40` |
| `/health` 가 연결 거부 | 작업 스케줄러 미시동 | `Get-ScheduledTaskInfo -TaskName 'Supertonic_Backend'` 의 LastTaskResult |
| import 에러 | 의존성 누락 | `python -c "from supertonic import TTS"` 실행 후 traceback 따라 `pip install ...` |
| `Start-ScheduledTask : Access is denied.` | 관리자 권한 PowerShell 아님 | 시작 메뉴 → PowerShell 우클릭 → 관리자 권한으로 실행 |
| `register-task.ps1` 실행 시 한글 깨짐 | PowerShell 5.1 codepage (CP949) | 작업 자체는 등록됨 — 메시지만 깨짐. 무시 OK. 또는 `chcp 65001` 후 재실행 |
| PrimingFlow 의 슈퍼톤 카드 자물쇠 안 풀림 | UI 폴링 타이밍 | 카드 한 번 더 클릭 (v1.10.5 inline retry) 또는 PrimingFlow 재시작 |

해결 안 되면 위 표의 로그 출력을 알려주세요.
