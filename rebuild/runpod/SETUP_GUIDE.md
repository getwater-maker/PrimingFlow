# RunPod 셋업 가이드 (컴맹용 단계별)

이 가이드는 PrimingFlow 사용자가 **처음 1회만** 따라하면 됩니다. 작업 시간 약 **60~90분**. 이후 PrimingFlow 가 모든 것을 자동으로 처리.

> ⚠️ 시작 전 준비물
> - 신용카드 (RunPod 결제용 — Visa/Master/Amex)
> - 인터넷 회선 (이미지 ~5GB 다운로드)
> - 이메일 주소 1개

---

## 단계 1. RunPod 가입 + 충전 (10분)

### 1-1. 가입
1. https://runpod.io 접속
2. 우측 상단 `Sign Up` → 이메일/Google/GitHub 중 편한 것
3. 이메일 인증 완료

### 1-2. 카드 등록 + 충전
1. 좌측 메뉴 `Billing` → `Add Funds`
2. 카드 정보 입력
3. **$20 충전** (한화 약 27,000원 — 첫 달 사용량 + 여유분)

**✅ 성공 신호**: 우측 상단에 `$20.00` 잔액 표시

**❌ 실패 시**:
- 한국 발급 카드가 거절되면 → 카카오뱅크/토스 가상카드 추천
- 결제 보류 (3D Secure 등) → 1~2분 대기 후 새로고침

---

## 단계 2. API Key 발급 (2분)

1. 좌측 메뉴 `Settings` → `API Keys`
2. `+ Create API Key` 클릭
3. 이름: `PrimingFlow` 입력 → `Create`
4. **표시되는 키를 메모장에 복사 저장** (다시는 안 보여줌!)

**✅ 성공 신호**: `rpa_` 로 시작하는 긴 문자열 (예: `rpa_ABC123...`)

---

## 단계 3. Docker Desktop 설치 + Docker Hub 가입 (15분)

이 단계는 **이미지 빌드 1회용**입니다. 빌드 끝나면 Docker Desktop 종료해도 됩니다.

### 3-1. Docker Desktop 설치 (Windows)
1. https://www.docker.com/products/docker-desktop/ → `Download for Windows`
2. 설치 파일 실행 → 기본값으로 설치 → **PC 재부팅**
3. 재부팅 후 Docker Desktop 실행 → "WSL2 확인" 나오면 `Yes`

**✅ 성공 신호**: 작업 표시줄에 고래 아이콘 + PowerShell 에서 다음 명령 결과 출력
```powershell
docker --version
```
→ `Docker version 27.x.x` 같은 줄

**❌ 실패 시**:
- "WSL2 not installed" → PowerShell 관리자 권한으로 `wsl --install` 실행 후 재부팅
- "Hyper-V disabled" → BIOS 에서 가상화 활성화 (메인보드별로 위치 다름, 사용자 검색 필요)

### 3-2. Docker Hub 가입
1. https://hub.docker.com → `Sign Up`
2. 사용자명 정하기 (예: `yourname`) — 이건 이미지 주소에 들어감
3. 이메일 인증

### 3-3. PowerShell 에서 Docker Hub 로그인
```powershell
docker login
```
→ Username 과 Password 입력

**✅ 성공 신호**: `Login Succeeded`

---

## 단계 4. Docker 이미지 빌드 + 푸시 (30~45분)

### 4-1. 빌드
PowerShell 에서 (한 줄씩 복사·붙여넣기):

```powershell
cd D:\PrimingFlow\rebuild\runpod
docker build -f docker/Dockerfile -t YOURNAME/primingflow-comfyui:1.0 .
```

> `YOURNAME` 부분을 본인의 Docker Hub 사용자명으로 바꾸세요. 예: `kimcheolsu/primingflow-comfyui:1.0`

⏱ **30~40분 소요** (인터넷 속도에 따라). PyTorch 다운로드가 가장 오래 걸림.

**✅ 성공 신호**: 마지막 줄에 `Successfully tagged YOURNAME/primingflow-comfyui:1.0`

**❌ 실패 시**:
- `no space left on device` → Docker Desktop 설정에서 디스크 공간 100GB 이상으로 확장
- 네트워크 끊김 → 같은 명령 다시 실행 (캐시 사용해서 더 빠름)

### 4-2. 푸시
```powershell
docker push YOURNAME/primingflow-comfyui:1.0
```

⏱ **5~15분 소요** (업로드 ~5GB).

**✅ 성공 신호**: `1.0: digest: sha256:...`

**확인**: https://hub.docker.com/r/YOURNAME/primingflow-comfyui 접속 → 1.0 tag 보임

---

## 단계 5. RunPod Template 생성 (5분)

RunPod 의 "Template" = Pod 시동 시 사용할 컨테이너 설정 묶음.

1. RunPod 좌측 메뉴 `Templates` → `+ New Template`
2. 다음 정보 입력:

| 필드 | 값 |
|---|---|
| Template Name | `PrimingFlow ComfyUI` |
| Container Image | `YOURNAME/primingflow-comfyui:1.0` |
| Container Disk | `80 GB` |
| Volume Disk | `0 GB` |
| Volume Mount Path | (비워둠) |
| Expose HTTP Ports | `8188` |
| Container Start Command | (비워둠 — Dockerfile 의 CMD 사용) |

3. `Environment Variables` 섹션:
   - `HF_HOME` = `/workspace/hf-cache`
   - `TORCH_HOME` = `/workspace/torch-cache`

4. `Save Template`

**✅ 성공 신호**: Templates 목록에 `PrimingFlow ComfyUI` 항목 표시
**메모해두기**: 생성된 Template ID (예: `abc123xyz`) — PrimingFlow 에서 사용

---

## 단계 6. PrimingFlow 에 등록 (3분)

> 이 단계는 Sonnet 세션이 UI 를 만든 후 가능합니다. Phase 1 코드 작업 완료 후 진행.

1. PrimingFlow 실행 (`npm start`)
2. 우측 상단 `🔑 시크릿` 모달
3. 추가될 입력 필드:
   - **RunPod API Key**: 단계 2 에서 복사한 `rpa_...` 키
   - **Template ID**: 단계 5 에서 만든 Template ID
   - **GPU 선호도**: `A40 48GB` (또는 `RTX 4090` — 둘 다 선택 권장)
   - **자동 종료 (분)**: `5` (5분 idle 시 Pod 자동 stop)

4. `테스트 시동` 버튼 → 60초 이내에 "✅ Pod 준비 완료" 표시되면 성공

**✅ 성공 신호**: 콘솔 로그에
```
[pod] starting...
[pod] running on https://abc123xyz-8188.proxy.runpod.net
[pod] ComfyUI ready
```

**❌ 실패 시**:
- `capacity error` → GPU 선호도 다중 선택 (A40 + RTX 4090 + RTX A5000 셋 다 체크)
- `image pull failed` → Docker Hub 이미지가 public 인지 확인 (Docker Hub 의 해당 repo 페이지 → Settings → Visibility = Public)
- `out of credits` → RunPod 잔액 확인, 추가 충전

---

## 단계 7. 첫 영상 생성 테스트 (5분)

1. PrimingFlow 에 짧은 대본 입력 (3 sentence):
```
조선시대 경복궁에서 왕이 즉위했다.
신하들이 모두 모여 경의를 표했다.
새로운 시대가 시작되었다.
```

2. `🚀 원클릭 생성` 버튼 클릭
3. 약 2~3분 대기 (Pod 부팅 1분 + 작업 1~2분)
4. `outputFolder/` 에 `.vrew` 파일 생성 확인

**✅ 성공 신호**:
- `outputFolder/{프로젝트명}/images/01.png` `02.png` `03.png` 생성
- `outputFolder/{프로젝트명}/videos/01.mp4` (도입부 1개)
- `outputFolder/{프로젝트명}/{프로젝트명}.vrew` 생성
- Vrew 4.0.1 에서 정상 열림

---

## 비용 모니터링

RunPod 좌측 `Billing` → `Usage` 에서 일/월별 사용량 확인 가능.

예상 비용:
- 1편당 약 $0.75 (1,000원 미만)
- 월 200편 = 약 $150 (약 20만 원)
- 5분 idle 후 자동 종료로 낭비 방지

**비용 알람**: `Billing` → `Set Spending Alert` 에서 월 $200 알림 설정 권장.

---

## FAQ

**Q. Pod 가 작업 중에 멈추는 경우?**
A. Spot 인스턴스라 우선순위 높은 사용자에게 GPU 가 빼앗길 수 있음 (preempt). PrimingFlow 가 자동으로 감지해서 5분 대기 후 재시동 + 미완료 작업부터 재개. 사용자는 그냥 기다리면 됨.

**Q. Docker 이미지를 업데이트하려면?**
A. Dockerfile 수정 → 빌드 시 tag 를 `1.1`, `1.2` 로 올림 → push → RunPod Template 의 Container Image 필드 갱신.

**Q. 한국 사용자 시간대 (저녁 7시~새벽 1시) GPU 부족?**
A. A40 + RTX 4090 + RTX A5000 셋 다 체크해두면 거의 항상 잡힘. 그래도 안 잡히면 작업 시간대 조정 또는 On-Demand 로 임시 전환.

**Q. 결과 이미지·비디오가 RunPod 에 남나요?**
A. 안 남습니다. Pod 종료 시 컨테이너 디스크 휘발. 결과물은 PrimingFlow 가 내 PC 에 다 받아옵니다.

**Q. 모델 다운로드를 매번 다시 하나요?**
A. 같은 Pod 가 살아있는 동안은 캐시. Pod 가 완전 stop 되면 다음 시동 시 다시 다운로드 (5~10분). 자주 작업한다면 Pod 종료 시간을 늘리거나(예: 30분 idle), Network Volume 으로 전환 ($4/월) 검토.
