/**
 * Flow Veo 비디오 엔진 (이미지 → Veo 영상)  — 렌더러측 Playwright (grok-engine 과 동일 인터페이스)
 *
 * 흐름 (실제 Flow DOM 실측 2026-06-05):
 *   1. labs.google/fx/ko/tools/flow → 프로젝트 진입 (프롬프트 바)
 *   2. 설정 칩 클릭 → role="tab" 팝업: "동영상" + 비율(9:16/16:9) + "1x" (모델 기본 Veo 3.1 Lite)
 *   3. "+" 또는 input[type=file] 로 시작 프레임 이미지 업로드
 *   4. 모션 프롬프트 입력 → 제출(→ / Enter)
 *   5. 좌측 미디어에 생성됨 (진행 % → ▶) → 우측 패널 "다운로드" 버튼 클릭 → mp4 다운로드
 *
 * grok-engine 과 같은 시그니처: generateVideoFromImage({imagePath, prompt, outputPath, abortSignal})
 *   → _convertGroupVideoBody 가 엔진만 갈아끼우면 됨. this._aspectRatio 로 9:16/16:9 결정.
 *
 * ⚠️ 비용: Veo 3.1 Lite 1클립 ≈ 수~수십 크레딧 (유료). 무료는 Grok 엔진 사용.
 */

const { chromium } = require('playwright');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { _ensureUserChromeProfileCopy } = require('./grok-engine');

const PROFILE_BASE = path.join(os.homedir(), '.flow-app', 'flow-veo-profiles');
const FLOW_URL = 'https://labs.google/fx/ko/tools/flow';

class FlowVeoEngine {
  constructor(opts = {}) {
    this.profileId = opts.profileId || 'default';
    this.profileDir = null;
    this.logger = typeof opts.logger === 'function' ? opts.logger : () => {};
    this.context = null;
    this.page = null;
    this._aspectRatio = null;   // '9:16' | '16:9'
  }
  log(msg) { this.logger(msg); }

  async start() {
    if (this.page && this.page.isClosed && this.page.isClosed()) {
      try { await this.context?.close(); } catch {}
      this.context = null; this.page = null;
    }
    if (this.context) { await this._ensureProject(); return; }

    if (!this.profileDir) {
      if (this.profileId === 'default') {
        const userCopy = await _ensureUserChromeProfileCopy(this.log.bind(this)).catch(() => null);
        this.profileDir = userCopy || path.join(PROFILE_BASE, 'default');
      } else {
        this.profileDir = path.join(PROFILE_BASE, this.profileId);
      }
    }
    fs.mkdirSync(this.profileDir, { recursive: true });
    try {
      for (const lock of ['SingletonLock', 'SingletonCookie', 'SingletonSocket']) {
        const p = path.join(this.profileDir, lock);
        if (fs.existsSync(p)) fs.unlinkSync(p);
      }
    } catch {}

    this.log('[Flow Veo] 브라우저 시작...');
    this.context = await chromium.launchPersistentContext(this.profileDir, {
      headless: false,
      viewport: null,
      args: ['--start-maximized', '--disable-blink-features=AutomationControlled'],
      ignoreDefaultArgs: ['--enable-automation'],
      acceptDownloads: true,
    });
    this.page = this.context.pages()[0] || await this.context.newPage();
    await this.page.addInitScript(() => {
      Object.defineProperty(navigator, 'webdriver', { get: () => false });
    });
    await this.page.goto(FLOW_URL, { waitUntil: 'networkidle', timeout: 60000 });
    await this.page.waitForTimeout(2000);
    await this._ensureProject();
  }

  // 프롬프트 바(프로젝트)로 진입 — 홈이면 '새 프로젝트' 클릭.
  async _ensureProject() {
    try {
      const hasInput = await this.page.getByRole('textbox').first().isVisible({ timeout: 2500 }).catch(() => false);
      if (hasInput) return;
      const newProj = this.page.getByText('새 프로젝트', { exact: false }).first();
      if (await newProj.isVisible({ timeout: 3000 }).catch(() => false)) {
        await newProj.click();
        await this.page.waitForTimeout(3500);
        this.log('[Flow Veo] 새 프로젝트 진입');
      } else {
        this.log('[Flow Veo] ⚠️ 프롬프트 바/새 프로젝트 못 찾음 — Flow 로그인 상태 확인 필요');
      }
    } catch (_) {}
  }

  async stop() {
    try { if (this.context) await this.context.close(); } catch {}
    this.context = null; this.page = null;
  }

  // ── 설정 팝업 (flow-engine 과 동일 — 매수 토큰/모델 키워드로 칩 찾기) ──
  async _openSettingsPopup() {
    const result = await this.page.evaluate(() => {
      const all = Array.from(document.querySelectorAll('button')).filter(b => b.offsetParent);
      const COUNT_RE = /(?:^|\s)(?:[1-4]x|x[1-4])\s*$/;
      const KW_RE = /Nano Banana|Veo|Imagen|Gemini|crop_|동영상/i;
      const cands = all.filter(b => {
        const t = (b.innerText || b.textContent || '').trim();
        return t.length > 0 && t.length < 120 && (COUNT_RE.test(t) || KW_RE.test(t));
      });
      const m = cands.find(b => COUNT_RE.test((b.innerText || b.textContent || '').trim())) || cands[0];
      if (m) { m.click(); return true; }
      return false;
    }).catch(() => false);
    return result;
  }
  async _isTabVisible(name) {
    try { return await this.page.getByRole('tab', { name, exact: true }).first().isVisible({ timeout: 800 }); }
    catch (_) { return false; }
  }
  async _clickTab(name) {
    try {
      const tab = this.page.getByRole('tab', { name, exact: true }).first();
      await tab.waitFor({ state: 'visible', timeout: 2500 });
      await tab.click({ timeout: 3000 });
      await this.page.waitForTimeout(150);
      return true;
    } catch (_) { return false; }
  }

  // 시작 프레임 이미지 업로드 — input[type=file] 우선, 없으면 "+" 첨부 트리거 후 filechooser.
  async _uploadStartImage(imagePath) {
    try {
      const inputs = await this.page.$$('input[type="file"]');
      if (inputs.length) {
        await inputs[0].setInputFiles(imagePath);
        await this.page.waitForTimeout(1800);
        return true;
      }
      // "+" 버튼 클릭 → filechooser 이벤트로 파일 지정
      const plus = this.page.locator('form button, [role="button"]').filter({ hasText: '' });
      try {
        const [chooser] = await Promise.all([
          this.page.waitForEvent('filechooser', { timeout: 4000 }),
          // "+" 는 보통 프롬프트 바 좌하단 첫 버튼 — 텍스트 없는 아이콘 버튼
          this.page.evaluate(() => {
            const btns = Array.from(document.querySelectorAll('form button')).filter(b => b.offsetParent);
            const add = btns.find(b => (b.innerText || '').trim() === '' || /add|첨부|\+/.test(b.getAttribute('aria-label') || ''));
            if (add) add.click();
          }),
        ]);
        await chooser.setFiles(imagePath);
        await this.page.waitForTimeout(1800);
        return true;
      } catch (e) {
        this.log(`[Flow Veo] [진단] 파일 input/"+" 첨부 못 찾음 (${e.message}) — 시작 이미지 없이 진행`);
        return false;
      }
    } catch (e) {
      this.log(`[Flow Veo] 시작 이미지 업로드 예외: ${e.message}`);
      return false;
    }
  }

  // 제출 — → 화살표 버튼 우선, Enter 백업.
  async _submit() {
    let clicked = false;
    try {
      clicked = await this.page.evaluate(() => {
        const btns = Array.from(document.querySelectorAll('form button, button')).filter(b => b.offsetParent);
        // arrow_forward 아이콘 또는 submit 타입
        const arrow = btns.find(b => /arrow_forward/i.test(b.innerText || b.textContent || '')
          || (b.getAttribute('type') === 'submit'));
        if (arrow && !arrow.disabled) { arrow.click(); return true; }
        return false;
      });
    } catch (_) {}
    if (!clicked) {
      try { await this.page.keyboard.press('Enter'); } catch (_) {}
    }
  }

  // 완료 대기 + 다운로드. 완료신호: 진행 %(예 "19%") 사라짐 + "다운로드" 버튼.
  async _waitAndDownload(outputPath, abortSignal) {
    const TIMEOUT = 6 * 60 * 1000, POLL = 5000, start = Date.now();
    let dumped = false;
    while (Date.now() - start < TIMEOUT) {
      if (abortSignal && abortSignal()) return { success: false, error: '사용자 중단' };
      await this.page.waitForTimeout(POLL);

      const generating = await this.page.evaluate(() => /\b\d{1,3}\s*%/.test(document.body.innerText || ''))
        .catch(() => false);
      const dlBtn = this.page.getByRole('button', { name: '다운로드' }).first();
      const dlVisible = await dlBtn.isVisible({ timeout: 500 }).catch(() => false);

      if (!generating && dlVisible) {
        try {
          const [download] = await Promise.all([
            this.page.waitForEvent('download', { timeout: 90000 }),
            dlBtn.click({ timeout: 5000 }),
          ]);
          await download.saveAs(outputPath);
          this.log(`[Flow Veo] ✅ 비디오 저장: ${path.basename(outputPath)}`);
          return { success: true, videoPath: outputPath };
        } catch (e) {
          this.log(`[Flow Veo] 다운로드 시도 실패 — 재시도: ${e.message}`);
        }
      } else if (!generating && !dlVisible && !dumped) {
        // 생성은 끝난 듯한데 다운로드 버튼을 못 찾음 → 1회 진단 덤프 (셀렉터 정밀화용)
        dumped = true;
        try {
          const html = await this.page.evaluate(() => {
            const tb = document.querySelector('main [role="toolbar"], [role="toolbar"]');
            return tb ? tb.outerHTML.replace(/\s+/g, ' ').slice(0, 500) : '(toolbar 없음)';
          });
          this.log(`[Flow Veo] [DUMP 결과 툴바] ${html}`);
        } catch (_) {}
      }
      this.log(`[Flow Veo] 생성 대기... (${Math.round((Date.now() - start) / 1000)}초)`);
    }
    return { success: false, error: '타임아웃 — 생성/다운로드 미완료' };
  }

  // grok-engine 과 동일 시그니처
  async generateVideoFromImage({ imagePath, prompt, outputPath, abortSignal }) {
    try {
      await this.start();
      if (abortSignal && abortSignal()) return { success: false, error: '사용자 중단' };
      const aspect = this._aspectRatio === '9:16' ? '9:16' : '16:9';

      // 1) 설정 팝업 → 동영상 + 비율 + 1x
      let opened = false;
      for (let r = 0; r < 3 && !opened; r++) {
        if (!(await this._isTabVisible('동영상'))) { await this._openSettingsPopup(); await this.page.waitForTimeout(800); }
        opened = await this._isTabVisible('동영상');
      }
      if (opened) {
        await this._clickTab('동영상');
        await this.page.waitForTimeout(400);
        await this._clickTab(aspect);
        await this._clickTab('1x');
        this.log(`[Flow Veo] 설정: 동영상 · ${aspect} · 1x · (모델 기본 Veo)`);
        await this.page.keyboard.press('Escape').catch(() => {});
        await this.page.waitForTimeout(300);
      } else {
        this.log('[Flow Veo] ⚠️ 설정 팝업 못 엶 — 기본 설정으로 진행');
      }

      // 2) 시작 프레임 업로드
      if (imagePath && fs.existsSync(imagePath)) {
        const ok = await this._uploadStartImage(imagePath);
        this.log(ok ? `[Flow Veo] 시작 이미지 업로드: ${path.basename(imagePath)}` : '[Flow Veo] 시작 이미지 없이 텍스트만으로 진행');
      }

      // 3) 모션 프롬프트
      const motion = (prompt || '').trim() || 'natural cinematic motion, slow camera movement';
      const input = this.page.getByRole('textbox').first();
      await input.click();
      try { await input.fill(motion); } catch (_) { await this.page.keyboard.type(motion); }
      await this.page.waitForTimeout(300);

      // 4) 제출
      await this._submit();
      this.log('[Flow Veo] 생성 요청 전송 — 완료 대기 (최대 6분)');

      // 5) 완료 + 다운로드
      return await this._waitAndDownload(outputPath, abortSignal);
    } catch (e) {
      this.log(`[Flow Veo] ❌ 예외: ${e.message}`);
      return { success: false, error: e.message };
    }
  }
}

module.exports = { FlowVeoEngine, PROFILE_BASE };
