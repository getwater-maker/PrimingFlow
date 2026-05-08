# 1단계 — 안티 디텍션 (ANTI_DETECT) 이식 계획서

작성일: 2026-04-29
모델 분담: 이 계획서까지 = **Opus** / 실제 코드 작성 = **Sonnet**
상태: 📋 검토 대기 (사용자 승인 후 코딩 단계 진입)

---

## Context — 왜 이걸 먼저 하는가

PrimingFlow 의 Google Flow 자동화는 현재 다음 두 가지만으로 봇 탐지를 회피하고 있다:

1. `_typePromptHumanized()` — 문자별 18~120ms 랜덤 딜레이 + 7% 확률 추가 정지 (`flow-engine.js:800`)
2. 403 발생 후 60초 고정 쿨다운 (`flow-engine.js:37, 429`)

이 정도로는 **단락 단위·세션 단위**의 자연스러움이 부족하다. 예를 들어 50개 단락을 처리할 때 단락 간 대기가 항상 정확히 2초(`flow-engine.js:592`) 라서, 시간 패턴만 보면 명백히 봇이다. Roy's Automator 가 이미 운영 환경에서 검증한 `ANTI_DETECT` 객체와 헬퍼들을 그대로 흡수해서, **단락·세션 레이어**의 휴먼화를 추가하는 것이 1단계 목표다.

타이핑 레이어는 이미 잘 되어 있으므로 그대로 두고, 그 위 레이어만 채운다.

---

## 출처 분석 요약 (Roy's Automator)

전체 분석은 [02-anti-detect-source-analysis.md](./02-anti-detect-source-analysis.md) 로 분리할 수도 있지만, 여기 핵심만 추린다.

### ANTI_DETECT 객체 (`sidepanel.js:88-102`)

| 키 | 값 | 용도 |
|---|---|---|
| `minDelay / maxDelay` | 8000 / 20000 ms | 가우시안 분포의 하한/상한 — 프롬프트 간 기본 대기 |
| `longPauseChance` | 0.10 | 10% 확률로 긴 대기 발동 |
| `longPauseMin / Max` | 30000 / 60000 ms | 긴 대기 범위 (30~60초) |
| `cooldownThreshold` | 12 | N개마다 강제 쿨다운 |
| `cooldownMin / Max` | 120000 / 300000 ms | 쿨다운 범위 (2~5분) |
| `dailyWarnLimit` | 50 | 일일 한도 (현재는 경고만) |
| `preSubmitDelayMin / Max` | 3000 / 8000 ms | 텍스트 주입 후 제출 전 대기 |
| `postGenDelayMin / Max` | 2000 / 5000 ms | 생성 완료 후 다운로드 전 대기 |

### 핵심 헬퍼

- **`getHumanDelay()`** (`sidepanel.js:104`) — Box-Muller 변환으로 가우시안 정규분포(평균 14000, σ 3000)에서 샘플 → [8000, 20000] 클립. 추가로 10% 확률 분기에서 [30000, 60000] 균등분포 반환.
- **`getCooldownDelay()`** (`sidepanel.js:122`) — [120000, 300000] 균등분포.
- **`sessionGeneratedCount % cooldownThreshold === 0`** 검사로 쿨다운 발동 (`sidepanel.js:1453`).
- **부가 트릭**: rate limit 감지 시 2~5분 대기 + 재시도 횟수 미소모, 연속 3회 실패 시 1~3분 비상 쿨다운, exponential backoff (10s→20s→60s).

### 주의할 한계 (개선해서 이식)

- 카운터가 **메모리 변수** (재시작 시 초기화) → PrimingFlow 에서는 **디스크 영속화** 로 바꿔야 일일 한도가 의미 있다.
- 일일 한도 도달해도 경고만 출력하고 계속 진행 → PrimingFlow 에서는 **선택적으로 차단** 옵션 제공.
- 날짜 롤오버 없음 → PrimingFlow 에서는 **자정(로컬 타임존) 롤오버** 추가.

---

## 목적지 분석 요약 (PrimingFlow)

### 자동화 흐름 진입점

```
ui/index.html (renderer)
  → ipcRenderer.invoke('start-generation', config)
     → main.js (난독화, 분석 불가)
        → FlowAutomator.run(config)               flow-engine.js:166
           → _runSequentialMode(...)              flow-engine.js:392
              → for (paragraph) { ... }           flow-engine.js:404
```

### 현재 코드의 딜레이 지점 (라인 = `flow-engine.js`)

| 위치 | 현재 처리 | 라인 |
|---|---|---|
| 프롬프트 타이핑 | 문자별 휴먼 딜레이 (이미 잘됨) | 800-831 |
| 타이핑 후 → 생성 클릭 전 | `waitForTimeout(500)` 고정 | 450 |
| 생성 클릭 → 결과 대기 | `_waitForImage(120000)` | 484 |
| 단락 간 대기 | `waitForTimeout(2000)` 고정 ⚠️ | 592 |
| 403 쿨다운 | 60초 고정 | 37, 429 |
| 재시도 딜레이 | 10초 고정 + 페이지 새로고침 | 519 |

⚠️ 표시한 곳이 **봇 패턴이 가장 도드라지는 지점** — 여기를 가우시안으로 교체하는 게 가성비 최고.

### 상태 저장

- 프로필: `%USERPROFILE%\.flow-app\profiles\<id>\` (Chromium 사용자 데이터)
- 앱 설정: `%USERPROFILE%\.flow-app\settings.json` (추정, main.js 가 난독화돼서 정확히는 못 봄)
- ➡️ **새로 추가할 안티 디텍션 상태는 같은 폴더에 `anti-detect-state.json` 으로 분리** — main.js 를 안 건드리는 원칙 + 손쉬운 디버깅.

### IPC

- `start-generation`, `stop-generation`, `pause-generation`, `resume-generation` 만 자동화에 직접 관련.
- `app-settings` 는 이미 있으니 안티 디텍션 설정도 같은 채널에 얹어 보낸다 (renderer → main → flow-engine 으로 config 에 합쳐 전달).

---

## 설계

### 핵심 결정 5가지

1. **모듈 분리**: 새 파일 `anti-detect.js` 를 만들어 클래스 또는 객체로 캡슐화. `flow-engine.js` 와 추후 `vrew-automator.js` 에서 공용으로 쓰기 위함. main.js 는 절대 건드리지 않는다.

2. **타이핑 레이어는 그대로**: `_typePromptHumanized()` 는 손대지 않는다. ANTI_DETECT 모듈은 그 위 단락·세션 레이어만 담당해서 이중 휴먼화를 만든다.

3. **상태 영속화**: 카운터·마지막 액션 시각·날짜를 `~\.flow-app\anti-detect-state.json` 에 저장. 자정 롤오버는 로드 시 날짜 비교로 처리.

4. **단순화된 UI 노출**: 13개 상수를 그대로 노출하지 않고 사용자에게는 4개만:
   - ON/OFF 토글 (기본 ON)
   - 강도 프리셋 (`순함` / `기본` / `강함` — 내부적으로 13개 값을 일괄 조정)
   - 일일 한도 (기본 50, 0 = 무제한)
   - 한도 도달 시 동작 (`경고만` / `자동 중지`, 기본 = 경고만)

5. **이식 강도 권장안 = 그대로 포팅 + 일일 한도만 강화**. Box-Muller, 쿨다운 임계값, 긴 대기 확률 등은 운영에서 검증된 값이므로 그대로 둔다. 일일 한도만 PrimingFlow 의 단독 사용 특성에 맞게 디스크 저장 + 자정 롤오버 + 선택적 차단으로 강화한다.

### `anti-detect.js` 인터페이스 설계

```js
// D:\PrimingFlow\rebuild\anti-detect.js
const fs = require('fs');
const path = require('path');
const os = require('os');

const STATE_PATH = path.join(os.homedir(), '.flow-app', 'anti-detect-state.json');

const PRESETS = {
  순함:   { mean: 10000, jitter: 4000, cooldownEvery: 8,  longPause: 0.05 },
  기본:   { mean: 14000, jitter: 6000, cooldownEvery: 12, longPause: 0.10 },
  강함:   { mean: 18000, jitter: 8000, cooldownEvery: 6,  longPause: 0.15 },
};

class AntiDetect {
  constructor(opts = {}) {
    this.enabled        = opts.enabled        ?? true;
    this.preset         = opts.preset         ?? '기본';
    this.dailyLimit     = opts.dailyLimit     ?? 50;
    this.onLimitReached = opts.onLimitReached ?? 'warn';   // 'warn' | 'stop'
    this.logger         = opts.logger         ?? console.log;

    this._loadState();
    this._applyPreset(this.preset);
  }

  // === 핵심 API (flow-engine.js 가 호출) ===

  // 단락 간 대기 — 라인 592 의 waitForTimeout(2000) 을 이걸로 교체
  getHumanDelay() { /* Box-Muller + 10% 긴 대기 */ }

  // 타이핑 후 → 생성 클릭 전 — 라인 450 의 500ms 를 이걸로 교체
  getPreSubmitDelay() { /* uniform(3000, 8000) */ }

  // 생성 클릭 직전 호출 → 12개마다 추가 쿨다운 반환 (없으면 0)
  // 또한 sessionGeneratedCount 증가시킴
  registerGenerationStart() { /* count++; modulo 검사; cooldown 반환 */ }

  // 403 또는 rate limit 감지 시 호출 — 라인 429 의 _handleRateLimit 강화
  getRateLimitCooldown() { /* uniform(120000, 300000) */ }

  // 재시도 backoff — 라인 519 의 10초 고정 교체
  getBackoffDelay(retryN, errorType) { /* exponential, 에러 타입별 */ }

  // run() 시작 시 호출 — true 면 사용자에게 한도 경고/중지
  checkDailyLimit() {
    return {
      reached: this.state.todayCount >= this.dailyLimit,
      remaining: Math.max(0, this.dailyLimit - this.state.todayCount),
      shouldStop: this.onLimitReached === 'stop' && this.state.todayCount >= this.dailyLimit,
    };
  }

  // === 상태 영속화 ===

  _loadState() {
    // STATE_PATH 읽기, 파싱 실패 시 기본값
    // 오늘 날짜와 저장된 날짜 비교 → 다르면 카운터 리셋 (자정 롤오버)
    // this.state = { date: '2026-04-29', todayCount: 0, lastActionAt: 0, sessionCount: 0 }
  }

  _persist() {
    // 비동기 fs.writeFile 로 저장 (메인 루프 블로킹 방지)
    // 실패해도 throw 하지 않음 — 로그만 남기고 계속
  }
}

module.exports = { AntiDetect, PRESETS };
```

### `flow-engine.js` 에 끼워 넣는 5개 지점

순서: 영향이 작고 안전한 것부터 — 각 단계마다 동작 확인 후 다음.

| # | 위치 | 변경 | 안전도 |
|---|---|---|---|
| **A** | `run()` 진입부 (라인 166 근처) | `this.antiDetect = new AntiDetect(config.antiDetect)` 인스턴스 생성. `checkDailyLimit()` 호출해서 `shouldStop` 이면 즉시 중단하고 사용자에게 보고 | ⭐⭐⭐⭐⭐ 매우 안전 (분기만 추가) |
| **B** | 단락 간 대기 (라인 592) | `waitForTimeout(2000)` → `waitForTimeout(this.antiDetect.getHumanDelay())` | ⭐⭐⭐⭐ 안전 (대기 시간만 변경) |
| **C** | 타이핑 후 → 생성 클릭 전 (라인 450) | `waitForTimeout(500)` → `waitForTimeout(this.antiDetect.getPreSubmitDelay())` | ⭐⭐⭐⭐ 안전 |
| **D** | 생성 클릭 직전 (라인 480 직전) | `const cd = this.antiDetect.registerGenerationStart(); if (cd > 0) { this.log('🛡️ 쿨다운'); await this.page.waitForTimeout(cd); }` | ⭐⭐⭐ 보통 (긴 쿨다운 추가됨) |
| **E** | 403 핸들러 (라인 429) `_handleRateLimit()` 내부 | 60초 고정 → `this.antiDetect.getRateLimitCooldown()` (2~5분) | ⭐⭐⭐ 보통 (Roy's Automator 의 검증된 값) |

5번째인 재시도 backoff (라인 519) 는 1단계에서 **제외**한다 — 현재 로직이 페이지 새로고침까지 결합돼 있어서 분리 리팩터링이 필요. 2단계 또는 별도 작업으로.

`anti-detect.enabled === false` 일 때는 모든 호출이 기존 동작과 동일한 값(2000ms, 500ms, 0, 60000ms)을 반환하도록 폴백 구현. 즉 OFF 토글로 즉시 원복 가능.

### `ui/index.html` 변경 (좌측 패널)

`<!-- Vrew 카메라 효과 -->` 섹션 (라인 ~ 445) **다음**에 새 `<div class="section">` 추가:

```html
<div class="section">
  <div class="section-title">계정 보호 (안티 디텍션)</div>
  <label class="switch"><input type="checkbox" id="antiDetectEnabled" checked> 활성화</label>
  <div class="setting">
    <label>강도</label>
    <div class="chip-group" id="antiDetectPreset">
      <div class="chip"        data-val="순함">순함</div>
      <div class="chip active" data-val="기본">기본</div>
      <div class="chip"        data-val="강함">강함</div>
    </div>
  </div>
  <div class="setting">
    <label>일일 한도 (0 = 무제한)</label>
    <input type="number" id="dailyLimit" value="50" min="0" max="500">
  </div>
  <div class="setting">
    <label>한도 도달 시</label>
    <div class="chip-group" id="onLimitReached">
      <div class="chip active" data-val="warn">경고만</div>
      <div class="chip"        data-val="stop">자동 중지</div>
    </div>
  </div>
  <div class="setting" id="antiDetectStatus" style="opacity:0.7;font-size:11px">
    오늘 0/50 회 · 세션 0회
  </div>
</div>
```

`startGeneration()` 의 `config` 객체에 다음 필드 추가:

```js
antiDetect: {
  enabled:        document.getElementById('antiDetectEnabled').checked,
  preset:         document.querySelector('#antiDetectPreset .chip.active').dataset.val,
  dailyLimit:     parseInt(document.getElementById('dailyLimit').value, 10) || 0,
  onLimitReached: document.querySelector('#onLimitReached .chip.active').dataset.val,
}
```

main.js 가 난독화돼 있어서 IPC 핸들러를 수정할 수는 없지만, `start-generation` 의 `config` 객체는 그대로 `FlowAutomator.run(config)` 로 전달되는 것이 분석에서 확인됐으므로 **추가 필드는 그대로 흘러간다**. 즉 main.js 수정 없음.

선택사항: `app-settings` IPC 채널이 이미 존재(`index.html:538`)하니, 사용자가 매번 세팅하지 않도록 마지막 안티 디텍션 설정을 함께 저장/복원. 단 main.js 가 어떤 키를 받는지 확인 못 했으므로 **렌더러 단의 localStorage 로 우선 저장** → 추후 확인되면 옮긴다.

---

## 수정 대상 파일 (확정)

| 파일 | 변경 종류 | 비고 |
|---|---|---|
| `D:\PrimingFlow\rebuild\anti-detect.js` | 신규 생성 | 약 200줄 예상 |
| `D:\PrimingFlow\rebuild\flow-engine.js` | 5개 지점 패치 | 라인 166, 450, 480 직전, 592, 429 |
| `D:\PrimingFlow\rebuild\ui\index.html` | UI 섹션 1개 + config 4필드 | 라인 ~445 (HTML), ~807 (config) |

**건드리지 않는 파일** (CLAUDE.md 의 절대 규칙):
- `main.js` — 난독화. 위 설계는 main.js 우회 가능 구조다.
- `_src/` — 아카이브.
- `auth-manager.js` — 더미 유지.

---

## 단계별 작업 순서 (코딩 단계에서 Sonnet 이 따를 순서)

각 단계 끝에서 **반드시 동작 확인** 후 다음으로 진행. 한꺼번에 다 바꾸면 어디서 깨졌는지 알 수 없다.

1. **anti-detect.js 모듈 생성 + 단위 테스트**
   - 파일 신설, 모든 헬퍼 구현, exports
   - 임시 테스트 스크립트로 `getHumanDelay()` 1만 회 호출해 평균 ≈ 14000, 표준편차 ≈ 3000 확인
   - 자정 롤오버: state 파일에 어제 날짜 박아두고 인스턴스 만들면 카운터 0 으로 리셋되는지 확인
   - 산출물: 콘솔에 통계만 출력되고 실 자동화는 영향 없음

2. **flow-engine.js 패치 — 지점 A, C, B (안전한 것부터)**
   - A (인스턴스 생성 + 일일 한도 체크) → C (preSubmit) → B (단락 간)
   - `npm start` 로 띄우고 5개 단락짜리 작은 대본으로 실행 → 로그에서 "단락 간 대기 14.3초" 같은 메시지 확인
   - 강도 프리셋 바꿔가며 평균 대기 시간이 변하는지 육안 확인

3. **flow-engine.js 패치 — 지점 D (12개 쿨다운)**
   - 13개 단락짜리 대본으로 실행 → 12번째 끝나고 13번째 시작 직전에 2~5분 쿨다운 발동 확인
   - cooldownEvery 가 8 인 "순함" 프리셋도 확인

4. **flow-engine.js 패치 — 지점 E (403 쿨다운 강화)**
   - 실제 403 을 일부러 트리거하기 어려우므로, `_handleRateLimit` 진입 시점에 임시 로그를 박고 코드 경로만 검증
   - 후속 작업: 의도적으로 반복 호출해서 403 유도 → 새 쿨다운 동작 확인 (시간이 걸리므로 별도)

5. **UI 통합**
   - HTML 섹션 추가, config 4필드 합류, 상태 표시(`antiDetectStatus`) 자동 갱신 (1초 폴링 또는 IPC 이벤트)
   - 토글 OFF 시 모든 동작이 기존과 동일하게 돌아오는지 확인 (회귀 테스트)

6. **localStorage 설정 영속화**
   - 안티 디텍션 4개 입력값을 `localStorage` 에 저장/복원
   - 다음 세션에서 사용자가 마지막 설정 그대로 시작할 수 있는지 확인

---

## 검증 (End-to-End 테스트 시나리오)

| # | 시나리오 | 기대 결과 |
|---|---|---|
| V1 | 토글 OFF 로 5단락 실행 | 단락 간 정확히 2초, 기존 동작과 동일 |
| V2 | 토글 ON / "기본" 프리셋 / 5단락 | 단락 간 8~20초 사이 가변 (로그에서 확인), 가끔 30~60초 긴 대기 |
| V3 | 토글 ON / "기본" / 13단락 | 12번째 단락 후 2~5분 쿨다운 발동 |
| V4 | 일일 한도 = 3, 동작 = 자동 중지 / 5단락 | 4번째 시도에서 즉시 중지 + 사용자 알림 |
| V5 | 일일 한도 = 3, 동작 = 경고만 / 5단락 | 5단락 모두 처리, 4번째부터 경고 로그 |
| V6 | V4 직후 다음 날 다시 실행 (날짜 변경 시뮬레이션) | 카운터 리셋되고 정상 진행 |
| V7 | 실행 도중 앱 강제 종료 → 재실행 | `anti-detect-state.json` 에서 todayCount 가 살아있는지 확인 |
| V8 | "강함" 프리셋 / 7단락 | 6번째 후 쿨다운 발동 (cooldownEvery=6), 평균 대기 18초 |

V1, V2, V4, V7 은 반드시 통과해야 1단계 완료. 나머지는 권장.

---

## 수치 자동 측정 스크립트 (선택)

코딩 단계에서 만들 수 있는 보조 도구 — 실제 자동화 없이 분포만 확인:

```js
// scripts/anti-detect-bench.js
const { AntiDetect } = require('../rebuild/anti-detect');
const ad = new AntiDetect({ preset: '기본' });
const samples = Array.from({length: 10000}, () => ad.getHumanDelay());
const mean = samples.reduce((a,b) => a+b) / samples.length;
const std  = Math.sqrt(samples.reduce((a,b) => a + (b-mean)**2, 0) / samples.length);
const long = samples.filter(s => s >= 30000).length;
console.log({ mean, std, longRatio: long/samples.length });
// 기대: mean ≈ 14000, std ≈ 3000~4500 (긴 대기 영향), longRatio ≈ 0.10
```

---

## 1단계 범위 밖 — 이후 단계로 미루는 항목

| 항목 | 이유 | 다음 단계 후보 |
|---|---|---|
| 재시도 backoff (`flow-engine.js:519`) | 페이지 새로고침 로직과 결합돼 분리 리팩터링 필요 | 1.5 단계 또는 2단계 |
| 연속 3회 실패 비상 쿨다운 | PrimingFlow 의 재시도 흐름 자체를 손봐야 함 | 1.5 단계 |
| Vrew 자동화에도 적용 | 1단계는 Flow 만. 모듈은 재사용 가능하게 만들어 둠 | Flow 검증 끝난 후 |
| 시간대별 활동률 (밤에는 자동 중단 등) | 과한 기능 — 사용자 요청 시 추가 | 보류 |
| 마우스 이동 노이즈 | Playwright 의 mouse API 활용. 효과 대비 복잡 | 보류 |

---

## 사용자에게 받아야 할 결정

코딩 진입 전에 한 번만 확인하면 좋은 사항들:

1. **모듈 분리** (anti-detect.js 신설) vs **flow-engine.js 안에 통합** — 권장은 분리. Vrew 에서도 쓸 거고 테스트도 쉬워서.
2. **강도 프리셋 3단계** vs **세부 슬라이더 노출** — 권장은 프리셋. 사용자 부담 적고 잘못된 값 입력 위험 낮음.
3. **일일 한도 도달 시 기본 동작** = 경고만 vs 자동 중지 — 권장은 경고만(현재 Roy's 와 동일). 단 UI 에서 바꿀 수 있음.
4. **anti-detect-state.json 위치** — `~\.flow-app\anti-detect-state.json` 권장. settings.json 과 분리해서 디버깅·삭제 쉽게.

---

## 다음 단계 진입 신호

이 계획서를 검토한 후, 사용자가 다음 중 하나를 명시적으로 말하면 코딩 단계 진입:

- "진행해" / "코딩해" / "시작해" / "1번부터 만들어" 등

이때 모델을 **Opus → Sonnet** 으로 전환 권장 (`/model claude-sonnet-4-6`). 파일 신설·패치·UI 작업은 Sonnet 이 더 빠르고 비용 효율적.
