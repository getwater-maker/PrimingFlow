/**
 * Grok Imagine 비디오 변환 엔진 (이미지 → 진짜 움직이는 영상)
 *
 * 흐름:
 *   1. Playwright 로 grok.com Imagine 페이지 진입
 *   2. 로그인 상태 확인 — 안 되어 있으면 사용자에게 수동 로그인 요청
 *   3. 입력 이미지 업로드
 *   4. 모션 프롬프트 입력
 *   5. Generate 클릭 → 폴링으로 완료 대기
 *   6. 완성된 mp4 다운로드 → outputPath 에 저장
 *
 * 인프라:
 *   - flow-engine.js 와 같은 패턴 (chromium.launchPersistentContext)
 *   - anti-detect.js 의 humanDelay / 일일 한도 (별도 store: tts/grok-store.js)
 *   - 로그인 자동화는 미구현 — 첫 실행 시 사용자가 직접 로그인 (이후 세션 유지)
 *
 * ⚠️ Selector TODO — 우토그록 v2.4.0 의 content.js 가 난독화되어 있어
 *    grok.com Imagine 의 정확한 selector 추출 불가. 첫 실행 시 사용자와 함께
 *    DevTools 로 selector 확인 후 GROK_SELECTORS 상수에 채워야 동작.
 */

const { chromium } = require('playwright');
const fs = require('fs');
const path = require('path');
const os = require('os');
const GrokStore = require('./tts/grok-store');

// 사용자 데이터 디렉토리 (Flow 프로필과 분리)
const PROFILE_BASE = path.join(os.homedir(), '.flow-app', 'grok-profiles');
const GROK_URL = 'https://grok.com/imagine';

// grok.com/imagine 의 비디오 생성 흐름 selector (사용자 DevTools 캡처 2026-05-06 기반).
// 핵심 컨테이너: form 안의 div.flex.flex-wrap.items-center.gap-1.5.px-2.py-2
//   - div:nth-child(1) = Agent (Beta)
//   - div:nth-child(2) = 이미지/비디오 토글 (그 안에 button 두 개)
//   - div:nth-child(3) = 해상도 (480p/720p — 비디오 모드 활성 후 등장)
//   - div:nth-child(4) = 길이 (6s/10s — 비디오 모드 활성 후 등장)
//   - div:nth-child(5) = 비율 dropdown trigger (16:9 등)
const CHIPS_CONTAINER = 'form div.flex.flex-wrap.items-center';

const GROK_SELECTORS = {
  // 텍스트(모션) 입력란 — placeholder "텍스트를 입력하여 상상해 보세요"
  promptInput:       'textarea[placeholder*="입력하여 상상"], textarea[placeholder*="imagine" i], textarea, form [contenteditable="true"]',
  // 이미지 업로드 — 페이지의 hidden input[type=file] 직접 접근
  fileInput:         'input[type="file"]',
  // "비디오" 모드 칩 — div:nth-child(2) 안의 비디오 button (이미지 button 과 같은 컨테이너)
  videoModeChip:     `${CHIPS_CONTAINER} > div:nth-child(2) button:has-text("비디오"), ${CHIPS_CONTAINER} > div:nth-child(2) button:has-text("Video")`,
  // 비디오 전용 옵션 칩 — 비디오 모드 활성 시에만 등장
  res480Chip:        `${CHIPS_CONTAINER} > div:nth-child(3) button:has-text("480p")`,
  res720Chip:        `${CHIPS_CONTAINER} > div:nth-child(3) button:has-text("720p")`,
  dur6sChip:         `${CHIPS_CONTAINER} > div:nth-child(4) button:has-text("6s")`,
  dur10sChip:        `${CHIPS_CONTAINER} > div:nth-child(4) button:has-text("10s")`,
  // 비율 dropdown 트리거 — div:nth-child(5) 의 button (radix 동적 ID 회피)
  aspectChipTrigger: `${CHIPS_CONTAINER} > div:nth-child(5) button`,
  // 비율 메뉴 항목 — radix dropdown 펼친 후 그 안의 5번째 항목 = "16:9 Widescreen"
  // (순서: 2:3 Tall, 3:2 Wide, 1:1 Square, 9:16 Vertical, 16:9 Widescreen)
  aspectMenu16x9:    '[role="menu"] > div:nth-child(5), [role="menu"] [role="menuitem"]:nth-child(5), [data-radix-popper-content-wrapper] [role="menuitem"]:nth-child(5)',
  aspectMenuFallback:'[role="menuitem"]:has-text("Widescreen"), [role="option"]:has-text("Widescreen"), [role="menuitem"]:has-text("16:9")',
  // Submit — form 안에서만 (form 밖의 다른 button 안 잡힘)
  submitButton:      'form button[type="submit"]',
  // 완성된 video element
  videoElement:      'main article video, main article source[src*=".mp4"]',
  // 다운로드 버튼 (사용자 캡처: 우측 사이드 버튼 그룹의 4번째)
  downloadButton:    'main article div.absolute.\\-right-14 button:nth-child(4), main article button[aria-label*="Download" i], main article button[aria-label*="다운" i]',
  // 로그인 안 됨 감지
  loginIndicator:    'a[href*="login" i], button:has-text("Sign in"), button:has-text("Log in"), button:has-text("로그인")',
};

/**
 * 사용자의 기본 크롬 프로필을 grok-profiles/userchrome/ 으로 한 번 복사.
 * 이미 복사된 흔적(Cookies 파일)이 있으면 건너뜀 — 매번 작동하지 않고 첫 실행 시만.
 * 복사가 부분 실패하거나 사용자 크롬 폴더가 없으면 null 반환 → 호출부가 격리 프로필로 폴백.
 *
 * 의도: 사용자가 평소 크롬에서 X 계정 (또는 grok.com) 에 이미 로그인돼 있으면
 *       그 쿠키·세션이 따라옴 → PrimingFlow 안에서 별도 X 로그인 불필요.
 *       사용자의 진짜 크롬 폴더는 건드리지 않음 (읽기만).
 */
async function _ensureUserChromeProfileCopy(log) {
  const targetDir = path.join(PROFILE_BASE, 'userchrome');
  const targetCookies = path.join(targetDir, 'Default', 'Cookies');
  if (fs.existsSync(targetCookies)) return targetDir;   // 이미 복사 완료 — 건너뜀

  // Windows 사용자 기본 크롬 프로필 위치
  const sourceUserData = path.join(os.homedir(),
    'AppData', 'Local', 'Google', 'Chrome', 'User Data');
  if (!fs.existsSync(sourceUserData)) {
    log('[Grok] 사용자 크롬 프로필 폴더 없음 — 격리 프로필 사용');
    return null;
  }

  log('[Grok] 첫 실행: 사용자 크롬 프로필을 복사합니다 (10~30초). 크롬을 닫아두면 더 안전합니다...');
  const targetDefault = path.join(targetDir, 'Default');
  fs.mkdirSync(targetDefault, { recursive: true });

  // 핵심 파일/폴더만 복사 (캐시·인덱스 등 큰 폴더 제외 — 빠르고 가벼움)
  const ESSENTIAL = [
    'Cookies', 'Cookies-journal',
    'Login Data', 'Login Data-journal',
    'Preferences', 'Bookmarks',
    'Local Storage', 'Session Storage',
    'History', 'Network',
  ];
  for (const item of ESSENTIAL) {
    const src = path.join(sourceUserData, 'Default', item);
    const dst = path.join(targetDefault, item);
    try {
      if (!fs.existsSync(src)) continue;
      const stat = fs.statSync(src);
      if (stat.isDirectory()) fs.cpSync(src, dst, { recursive: true, force: true });
      else fs.copyFileSync(src, dst);
    } catch (e) {
      // Cookies 잠금 등 — 부분 실패는 로그 후 계속 (다른 파일이라도 가져오면 도움)
      log(`[Grok]   ${item} 복사 스킵: ${e.message}`);
    }
  }
  // Local State (필수 — Chrome 부팅에 필요)
  try {
    const ls = path.join(sourceUserData, 'Local State');
    if (fs.existsSync(ls)) fs.copyFileSync(ls, path.join(targetDir, 'Local State'));
  } catch {}

  if (fs.existsSync(targetCookies)) {
    log('[Grok] 프로필 복사 완료 — 평소 크롬 로그인 세션이 따라옵니다.');
    return targetDir;
  }
  log('[Grok] Cookies 복사 실패 (크롬 실행 중일 수 있음) — 격리 프로필 사용. 첫 실행 시 X 계정 로그인 필요.');
  return null;
}

class GrokEngine {
  constructor(opts = {}) {
    this.profileId = opts.profileId || 'default';
    // profileDir 는 start() 에서 결정 — profileId='default' 면 사용자 크롬 프로필 복사 시도,
    // 명시적 profileId 면 그 격리 프로필 사용.
    this.profileDir = null;
    this.logger = typeof opts.logger === 'function' ? opts.logger : () => {};
    this.context = null;
    this.page = null;
  }

  log(msg) { this.logger(msg); }

  /** dialog-portal 의 open backdrop 이 있으면 ESC 로 닫아 클릭 가로챔 방지 */
  async _dismissAnyDialog() {
    try {
      let dialog = await this.page.$('#dialog-portal [data-state="open"]');
      let attempts = 0;
      while (dialog && attempts < 3) {
        await this.page.keyboard.press('Escape');
        await this.page.waitForTimeout(400);
        dialog = await this.page.$('#dialog-portal [data-state="open"]');
        attempts++;
      }
      if (attempts > 0) this.log(`[Grok] dialog backdrop 닫음 (ESC ${attempts}회)`);
    } catch {}
  }

  async start() {
    // 페이지가 닫혔으면 컨텍스트도 폐기 후 재시작
    if (this.page && this.page.isClosed && this.page.isClosed()) {
      try { await this.context?.close(); } catch {}
      this.context = null;
      this.page = null;
    }
    if (this.context) return;

    // 첫 호출 시 profileDir 결정.
    // - profileId='default' (기본): 사용자 크롬 프로필 복사 시도 → 평소 크롬 로그인 세션 활용.
    // - 명시적 profileId: 격리 프로필 (기존 동작 유지).
    if (!this.profileDir) {
      if (this.profileId === 'default') {
        const userCopy = await _ensureUserChromeProfileCopy(this.log.bind(this)).catch(() => null);
        this.profileDir = userCopy || path.join(PROFILE_BASE, 'default');
      } else {
        this.profileDir = path.join(PROFILE_BASE, this.profileId);
      }
    }

    fs.mkdirSync(this.profileDir, { recursive: true });
    // 잠금 파일 제거 (이전 비정상 종료 흔적)
    try {
      for (const lock of ['SingletonLock', 'SingletonCookie', 'SingletonSocket']) {
        const p = path.join(this.profileDir, lock);
        if (fs.existsSync(p)) fs.unlinkSync(p);
      }
    } catch {}

    this.log('[Grok] 브라우저 시작 (Grok Imagine)...');
    this.context = await chromium.launchPersistentContext(this.profileDir, {
      headless: false,
      viewport: null,                                // 시스템 화면 크기 그대로 (축소 방지)
      args: [
        '--start-maximized',                         // 전체 화면으로 시작
        '--disable-blink-features=AutomationControlled',
      ],
      ignoreDefaultArgs: ['--enable-automation'],
      acceptDownloads: true,
      permissions: ['clipboard-read', 'clipboard-write'],
    });
    this.page = this.context.pages()[0] || await this.context.newPage();
    await this.page.addInitScript(() => {
      Object.defineProperty(navigator, 'webdriver', { get: () => false });
    });

    await this.page.goto(GROK_URL, { waitUntil: 'networkidle', timeout: 30000 });
    await this.page.waitForTimeout(3000);

    // 페이지 로드 직후 dialog 가 떠있으면 닫기 (광고/안내/Premium 확인 등)
    await this._dismissAnyDialog();

    // 로그인 상태 확인
    const loginIndicator = await this.page.$(GROK_SELECTORS.loginIndicator);
    if (loginIndicator) {
      this.log('[Grok] 로그인이 필요합니다. 브라우저에서 X 계정으로 로그인하세요. (한 번 로그인하면 이후엔 자동)');
      // grok.com 안의 다른 페이지로 이동하면 로그인 완료로 간주 (최대 5분 대기)
      await this.page.waitForFunction(
        () => !document.querySelector('a[href*="login" i], button:has-text("Sign in"), button:has-text("Log in")'),
        { timeout: 300000 }
      ).catch(() => {});
      this.log('[Grok] 로그인 감지 — 진행합니다.');
    } else {
      this.log('[Grok] 이미 로그인되어 있습니다.');
    }
  }

  async stop() {
    if (this.context) {
      try { await this.context.close(); } catch {}
      this.context = null;
      this.page = null;
    }
  }

  /**
   * 그록 로그인 페이지로 이동 — 사용자가 X 계정 로그인 미리 해두는 용도.
   * 자동화 크롬 시작 후 grok.com/login 페이지로 직행.
   * 이미 로그인돼 있으면 grok 이 자동으로 메인 페이지로 redirect.
   */
  async openLoginPage() {
    await this.start();   // 브라우저 시작 (start 가 grok.com/imagine 까지 이동)
    try {
      this.log('[Grok] 로그인 페이지로 이동');
      await this.page.goto('https://grok.com/login', {
        waitUntil: 'domcontentloaded',
        timeout: 30000,
      });
    } catch (e) {
      this.log(`[Grok] /login 이동 실패: ${e.message} — 메인 페이지에 머무름`);
    }
  }

  /**
   * 이미지 1장 → 비디오 1개 생성.
   * @param {object} args
   *   imagePath   : 입력 이미지 절대경로
   *   prompt      : 모션 프롬프트 (없으면 grok-store 의 defaultMotionPrompt 사용)
   *   outputPath  : 결과 mp4 저장 경로 (절대)
   *   abortSignal : () => boolean 형태. true 반환 시 중단
   * @returns { success, videoPath?, error? }
   */
  async generateVideoFromImage({ imagePath, prompt, outputPath, abortSignal }) {
    // 1. 일일 한도 체크
    const limit = GrokStore.checkDailyLimit();
    if (!limit.allowed) {
      return { success: false, error: limit.reason };
    }

    // 2. 입력 검증
    if (!imagePath || !fs.existsSync(imagePath)) {
      return { success: false, error: `입력 이미지 없음: ${imagePath}` };
    }
    if (!outputPath) return { success: false, error: 'outputPath 필수' };
    fs.mkdirSync(path.dirname(outputPath), { recursive: true });

    const motion = (prompt && prompt.trim()) || limit.cfg.defaultMotionPrompt;

    // 3. 브라우저 시작 보장 (page 가 closed 면 start() 가 자동 재기동)
    if (this.page && this.page.isClosed && this.page.isClosed()) {
      this.log('[Grok] 이전 세션이 닫혀있음 — 재시작');
      try { await this.context?.close(); } catch {}
      this.context = null;
      this.page = null;
    }
    await this.start();
    if (abortSignal && abortSignal()) return { success: false, error: '사용자 중단' };

    try {
      this.log(`[Grok] 비디오 생성 시작 — ${path.basename(imagePath)} · "${motion.substring(0, 40)}"`);

      // 4. /imagine 진입 (이전 결과 페이지 /imagine/post/... 에 있으면 메인으로 이동)
      if (!this.page.url().endsWith('/imagine') && !this.page.url().endsWith('/imagine/')) {
        await this.page.goto(GROK_URL, { waitUntil: 'networkidle', timeout: 30000 });
        await this.page.waitForTimeout(2000);
      }
      // 진입 후 떠있는 모든 dialog 닫기
      await this._dismissAnyDialog();
      if (abortSignal && abortSignal()) return { success: false, error: '사용자 중단' };

      // 5. "비디오" 모드 칩 클릭 — 이미지 → 비디오 변환의 핵심
      // 검증: 클릭 후 480p / 6s 같은 비디오 전용 칩이 등장하면 active 성공
      const videoChip = await this.page.$(GROK_SELECTORS.videoModeChip);
      if (!videoChip) {
        return { success: false, error: '"비디오" 칩 못 찾음 (selector: ' + GROK_SELECTORS.videoModeChip + ')' };
      }
      // 첫 시도 — 일반 click. dialog 가 가로채면 force 옵션 사용
      try {
        await videoChip.click({ timeout: 5000 });
      } catch (e) {
        this.log(`[Grok] 비디오 칩 일반 클릭 실패 — force 옵션 재시도: ${e.message}`);
        await this._dismissAnyDialog();
        await videoChip.click({ force: true, timeout: 5000 }).catch(() => {});
      }
      await this.page.waitForTimeout(1500);  // 비디오 모드 옵션 등장 충분히 대기

      const verify = await this.page.$(GROK_SELECTORS.res480Chip)
                  || await this.page.$(GROK_SELECTORS.res720Chip);
      if (verify) {
        this.log('[Grok] "비디오" 모드 활성화 확인 (해상도 칩 등장)');
      } else {
        // 한 번 더
        await this._dismissAnyDialog();
        await videoChip.click({ force: true }).catch(() => {});
        await this.page.waitForTimeout(1500);
        const verify2 = await this.page.$(GROK_SELECTORS.res480Chip)
                     || await this.page.$(GROK_SELECTORS.res720Chip);
        if (verify2) {
          this.log('[Grok] "비디오" 모드 활성화 확인 (재시도 후)');
        } else {
          this.log('[Grok] ⚠️ "비디오" 모드 활성 검증 실패 — 그래도 진행');
        }
      }

      // 5-2. 비디오 해상도 / 길이 / 비율 옵션 적용 (grok-store 설정값)
      const grokCfg = GrokStore.load();
      const resChipSel = grokCfg.videoResolution === '720p'
        ? GROK_SELECTORS.res720Chip : GROK_SELECTORS.res480Chip;
      const durChipSel = grokCfg.videoDuration === '10s'
        ? GROK_SELECTORS.dur10sChip : GROK_SELECTORS.dur6sChip;
      try {
        const resChip = await this.page.$(resChipSel);
        if (resChip) { await resChip.click(); await this.page.waitForTimeout(300); }
        const durChip = await this.page.$(durChipSel);
        if (durChip) { await durChip.click(); await this.page.waitForTimeout(300); }

        // 비율 dropdown — div:nth-child(5) 트리거 클릭 → 메뉴 5번째 항목 (16:9 Widescreen) 클릭
        const aspectTrigger = await this.page.$(GROK_SELECTORS.aspectChipTrigger);
        if (aspectTrigger) {
          await aspectTrigger.click();
          await this.page.waitForTimeout(500);
          // 1순위: 메뉴의 5번째 div = "16:9 Widescreen" (사용자 캡처 기준)
          let menuItem = await this.page.$(GROK_SELECTORS.aspectMenu16x9);
          // 2순위: 텍스트 "Widescreen" / "16:9" 포함 항목
          if (!menuItem) {
            menuItem = await this.page.$(GROK_SELECTORS.aspectMenuFallback);
          }
          if (menuItem) {
            await menuItem.click();
            await this.page.waitForTimeout(300);
            this.log(`[Grok] 비율 선택: 16:9 Widescreen`);
          } else {
            this.log(`[Grok] ⚠️ 비율 메뉴 항목 못 찾음 — 현재 비율 유지 (ESC)`);
            await this.page.keyboard.press('Escape').catch(() => {});
          }
        }
        this.log(`[Grok] 옵션: ${grokCfg.videoResolution} · ${grokCfg.videoDuration} · ${grokCfg.videoAspect}`);
      } catch (e) {
        this.log(`[Grok] 비디오 옵션 적용 중 예외 (무시): ${e.message}`);
      }

      // 6. 이미지 업로드 — hidden input[type=file]
      await this._dismissAnyDialog();
      const fileInput = await this.page.$(GROK_SELECTORS.fileInput);
      if (!fileInput) {
        return { success: false, error: `이미지 업로드 input 못 찾음 (selector: ${GROK_SELECTORS.fileInput})` };
      }
      await fileInput.setInputFiles(imagePath);
      await this.page.waitForTimeout(1500);
      this.log(`[Grok] 이미지 업로드: ${path.basename(imagePath)}`);
      if (abortSignal && abortSignal()) return { success: false, error: '사용자 중단' };

      // 7. 모션 프롬프트 입력 — 자연스러운 타이핑 속도 (delay 16ms, 약 분당 380자)
      //    감속 이력: 10 → 13 → 16 (사용자 요청에 따라 단계적 감속).
      const promptEl = await this.page.$(GROK_SELECTORS.promptInput);
      if (promptEl) {
        await promptEl.click();
        const tagName = await promptEl.evaluate(el => el.tagName.toLowerCase());
        if (tagName === 'textarea' || tagName === 'input') {
          // textarea 도 keyboard.type 으로 변경 — 자연스러운 타이핑 속도 적용
          await this.page.keyboard.type(motion, { delay: 16 });
        } else {
          // contenteditable
          await this.page.keyboard.type(motion, { delay: 16 });
        }
        await this.page.waitForTimeout(500);
        this.log(`[Grok] 모션 프롬프트 입력: "${motion.substring(0, 40)}..." (delay 16ms)`);
      } else {
        this.log('[Grok] ⚠️ 프롬프트 입력 영역 못 찾음 — 빈 프롬프트로 진행');
      }
      if (abortSignal && abortSignal()) return { success: false, error: '사용자 중단' };

      // 8. Submit — submit 버튼 우선, 안 되면 Enter 키
      await this._dismissAnyDialog();
      const submitBtn = await this.page.$(GROK_SELECTORS.submitButton);
      if (submitBtn) {
        await submitBtn.click();
      } else {
        await this.page.keyboard.press('Enter');
      }
      this.log('[Grok] 생성 요청 전송 — 결과 페이지로 이동 대기');

      // 9. URL 이 /imagine/post/<UUID> 로 변경되는 것 감지
      try {
        await this.page.waitForURL(/\/imagine\/post\//, { timeout: 30000 });
        this.log(`[Grok] 결과 페이지 진입: ${this.page.url()}`);
      } catch (e) {
        return { success: false, error: '결과 페이지로 이동 안 됨 (30초 timeout). 입력/Submit 단계 selector 확인 필요' };
      }

      // 10. 비디오 생성 완료 대기 (폴링)
      // 완료 신호: <video> 등장 + downloadButton 클릭 가능
      const POLL_INTERVAL = 5000;
      const TIMEOUT_MS = 10 * 60 * 1000;  // 최대 10분 (5분으로 부족한 케이스 빈번)
      const startedAt = Date.now();
      let videoUrl = null;
      while (Date.now() - startedAt < TIMEOUT_MS) {
        if (abortSignal && abortSignal()) return { success: false, error: '사용자 중단' };
        await this.page.waitForTimeout(POLL_INTERVAL);

        // <video> 요소에서 src 추출 시도
        const v = await this.page.$(GROK_SELECTORS.videoElement);
        if (v) {
          const src = await v.getAttribute('src');
          if (src && !src.includes('blob:')) {
            // blob: 가 아닌 실제 URL 이면 직접 fetch 가능
            videoUrl = src;
            this.log(`[Grok] video src 감지: ${src.substring(0, 60)}...`);
          } else if (src) {
            this.log(`[Grok] blob video 감지 — 다운로드 버튼 사용`);
          }
        }

        // 다운로드 버튼이 있으면 enabled + 비디오 ready 두 조건 모두 만족할 때만 클릭.
        // (이전 버그: enabled 만으로 클릭 → 생성 중인 placeholder 다운로드 → 정적 10초 mp4)
        // videoReady 정의: <video> 의 duration > 1초 + readyState >= 2 (HAVE_CURRENT_DATA).
        // 둘 다 진짜 생성 완료된 비디오 element 가 mount 됐을 때만 true.
        const dlBtn = await this.page.$(GROK_SELECTORS.downloadButton);
        let dlEnabled = false;
        if (dlBtn) {
          try { dlEnabled = await dlBtn.isEnabled(); } catch { dlEnabled = false; }
        }
        let videoReady = false;
        if (dlEnabled) {
          try {
            videoReady = await this.page.evaluate(() => {
              const v = document.querySelector('main article video');
              if (!v) return false;
              const dur = isFinite(v.duration) ? v.duration : 0;
              return v.readyState >= 2 && dur > 1;
            });
          } catch { videoReady = false; }
          if (!videoReady) {
            // 다운로드 버튼은 enabled 인데 비디오는 아직 안 됨 — 다음 폴링 사이클로
            const elapsed = Math.round((Date.now() - startedAt) / 1000);
            this.log(`[Grok] 버튼 enabled 이나 비디오 미준비 (대기 ${elapsed}s)`);
          }
        }
        if (dlBtn && dlEnabled && videoReady) {
          this.log('[Grok] 다운로드 버튼 클릭 (대기 90초)');
          try {
            const [download] = await Promise.all([
              this.page.waitForEvent('download', { timeout: 90000 }),  // 30초 → 90초
              // click 자체는 5초 안에 안 되면 다음 폴링 사이클로 빠르게 복귀
              // (Playwright 기본 actionTimeout 30초가 disabled 상태에서 까먹는 시간 줄임)
              dlBtn.click({ timeout: 5000 }),
            ]);
            await download.saveAs(outputPath);
            GrokStore.markUsed();
            this.log(`[Grok] ✅ 비디오 저장 완료: ${outputPath}`);
            return { success: true, videoPath: outputPath };
          } catch (e) {
            this.log(`[Grok] 다운로드 이벤트 timeout — video src fallback 시도: ${e.message}`);
            // fallback A: video element 의 src 가 https URL 이면 직접 fetch
            if (videoUrl && videoUrl.startsWith('http')) {
              try {
                const res = await this.page.context().request.get(videoUrl);
                const buf = await res.body();
                fs.writeFileSync(outputPath, buf);
                GrokStore.markUsed();
                this.log(`[Grok] ✅ video URL 직접 다운로드: ${outputPath}`);
                return { success: true, videoPath: outputPath };
              } catch {}
            }
            // fallback B: video element 가 blob: 면 페이지 안에서 fetch → base64 → 디스크 저장
            try {
              const base64 = await this.page.evaluate(async () => {
                const v = document.querySelector('main article video, main article source[src*=".mp4"]');
                if (!v) return null;
                const src = v.src || (v.querySelector ? '' : '');
                if (!src) return null;
                const r = await fetch(src);
                const blob = await r.blob();
                return await new Promise((resolve, reject) => {
                  const fr = new FileReader();
                  fr.onload = () => resolve(fr.result);
                  fr.onerror = reject;
                  fr.readAsDataURL(blob);
                });
              });
              if (base64 && base64.includes('base64,')) {
                const pure = base64.split('base64,')[1];
                fs.writeFileSync(outputPath, Buffer.from(pure, 'base64'));
                GrokStore.markUsed();
                this.log(`[Grok] ✅ blob video → base64 저장: ${outputPath}`);
                return { success: true, videoPath: outputPath };
              }
            } catch (e2) {
              this.log(`[Grok] base64 fallback 실패: ${e2.message}`);
            }
          }
        }

        const elapsed = Math.round((Date.now() - startedAt) / 1000);
        this.log(`[Grok] 생성 대기 중... (${elapsed}초)`);
      }

      // <video> URL fallback
      if (videoUrl) {
        try {
          const res = await this.page.context().request.get(videoUrl);
          const buf = await res.body();
          fs.writeFileSync(outputPath, buf);
          GrokStore.markUsed();
          this.log(`[Grok] ✅ 비디오 URL 다운로드 완료: ${outputPath}`);
          return { success: true, videoPath: outputPath };
        } catch (e) {
          return { success: false, error: `video URL 다운로드 실패: ${e.message}` };
        }
      }

      return { success: false, error: '5분 대기 후에도 비디오 미완성 (timeout)' };
    } catch (e) {
      return { success: false, error: `Grok 자동화 예외: ${e.message}` };
    }
  }
}

module.exports = { GrokEngine, GROK_SELECTORS, PROFILE_BASE };
