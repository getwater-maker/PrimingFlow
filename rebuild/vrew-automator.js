/**
 * Vrew UI Automator v2 — 실제 Vrew 3.8.1 DOM 구조 기반
 *
 * 핵심 발견 (2026-04-08 DOM 분석):
 * - 툴바: button.toolbar-left-button (텍스트: 파일, 홈, 편집, 자막, 서식, 삽입, AI 목소리, 템플릿, 효과, 도움말)
 * - 모달: .ReactModal__Overlay → button.blue-button(확인), button.white-button(나중에)
 * - 파일 열기: CLI 인자 전달 (Vrew.exe "file.vrew") → 이미 실행 중이면 파일만 전달됨
 * - AI 더빙: "AI 자막 더빙" 드롭다운 (id=radix-9)
 * - evaluate()로 직접 DOM 클릭 (Playwright click은 모달에 가로막힘)
 */

const EventEmitter = require('events');

// Vrew 성우 목록 (ko-KR, provider: "vrew")
const DEFAULT_SPEAKERS = [
  { name: 'butter_f', speakerId: 'characteristic2', displayName: '버터 (여성)', gender: 'female', age: 'middle', badge: 'Recommended' },
  { name: 'aria_f', speakerId: 'characteristic1', displayName: '아리아 (여성)', gender: 'female', age: 'young' },
  { name: 'hajun_m', speakerId: 'standard1', displayName: '하준 (남성)', gender: 'male', age: 'young' },
  { name: 'seoyon_f', speakerId: 'standard2', displayName: '서연 (여성)', gender: 'female', age: 'young' },
  { name: 'jimin_f', speakerId: 'standard3', displayName: '지민 (여성)', gender: 'female', age: 'middle' },
  { name: 'minseo_f', speakerId: 'standard4', displayName: '민서 (여성)', gender: 'female', age: 'young' },
  { name: 'doyun_m', speakerId: 'standard5', displayName: '도윤 (남성)', gender: 'male', age: 'middle' },
  { name: 'yuna_f', speakerId: 'standard6', displayName: '유나 (여성)', gender: 'female', age: 'young' },
  { name: 'siwoo_m', speakerId: 'standard7', displayName: '시우 (남성)', gender: 'male', age: 'young' },
  { name: 'jiwon_f', speakerId: 'standard8', displayName: '지원 (여성)', gender: 'female', age: 'middle' },
];

class VrewAutomator extends EventEmitter {
  constructor(connector, mainWindow) {
    super();
    this.connector = connector;
    this.win = mainWindow;
    this.speakers = [...DEFAULT_SPEAKERS];
  }

  get page() { return this.connector.page; }

  log(msg) {
    console.log(`[VrewAutomator] ${msg}`);
    if (this.win && !this.win.isDestroyed()) {
      this.win.webContents.send('log', `[Vrew] ${msg}`);
    }
  }

  progress(current, total, status) {
    if (this.win && !this.win.isDestroyed()) {
      this.win.webContents.send('vrew:progress', { current, total, status });
    }
    this.emit('progress', { current, total, status });
  }

  // ─── 모달 자동 닫기 (D56 에러 등) ──────────────
  async dismissModals() {
    const page = this.page;
    let dismissed = 0;

    for (let attempt = 0; attempt < 5; attempt++) {
      const closed = await page.evaluate(() => {
        const overlay = document.querySelector('.ReactModal__Overlay');
        if (!overlay) return false;

        // 확인/나중에/닫기/OK 버튼 찾기
        const btns = overlay.querySelectorAll('button');
        for (const b of btns) {
          const t = b.textContent.trim();
          if (t === '확인' || t === '나중에' || t === '닫기' || t === 'OK' || t === 'Close') {
            b.click();
            return t;
          }
        }
        // X 버튼
        const xBtn = overlay.querySelector('.header-cancel, [class*="close"]');
        if (xBtn) { xBtn.click(); return 'X'; }

        return false;
      });

      if (!closed) break;
      this.log(`모달 닫기: "${closed}"`);
      dismissed++;
      await this._sleep(1000);
    }

    return dismissed;
  }

  // ─── .vrew 파일 열기 (CLI 인자 방식) ────────────
  async openFile(filePath) {
    await this.connector.ensureConnected();
    this.log(`파일 열기: ${filePath}`);

    // CLI 인자로 파일 전달 (가장 안정적)
    await this.connector.openFileViaCli(filePath);

    // Vrew UI 로딩 대기
    this.log('파일 로드 대기...');
    await this._sleep(5000); // Vrew가 파일 처리하는 시간

    // 모달 자동 닫기 (D56 등)
    await this.dismissModals();

    // 페이지 새로고침 (파일이 다른 페이지에서 열릴 수 있음)
    const pages = this.connector.browser.contexts()[0].pages();
    for (const pg of pages) {
      const title = await pg.title().catch(() => '');
      if (title.includes('.vrew') || title.includes('Vrew')) {
        this.connector.page = pg;
        break;
      }
    }

    // 편집 버튼 활성화 확인
    const ready = await this.page.evaluate(() => {
      const btns = document.querySelectorAll('button.toolbar-left-button');
      for (const b of btns) {
        if (b.textContent.includes('편집') && !b.classList.contains('disabled')) return true;
      }
      return false;
    });

    if (ready) {
      this.log('파일 로드 완료 — 편집 모드 활성화됨');
    } else {
      this.log('파일 로드됨 — 편집 버튼 아직 비활성 (대기 중...)');
      await this._sleep(5000);
      await this.dismissModals();
    }
  }

  // ─── 성우 목록 ──────────────────────────────
  async getSpeakers() {
    return this.speakers;
  }

  // ─── AI 목소리 탭 클릭 ──────────────────────
  async clickAiVoiceTab() {
    const page = this.page;

    // evaluate로 직접 클릭 (Playwright click은 모달에 가로막힘)
    const clicked = await page.evaluate(() => {
      const btns = document.querySelectorAll('button.toolbar-left-button');
      for (const b of btns) {
        if (b.textContent.includes('AI 목소리') && !b.classList.contains('disabled')) {
          b.click();
          return true;
        }
      }
      return false;
    });

    if (clicked) {
      this.log('AI 목소리 탭 클릭 성공');
      await this._sleep(2000);
    } else {
      this.log('AI 목소리 탭 비활성 — 파일이 로드되지 않았을 수 있습니다');
    }

    return clicked;
  }

  // ─── 전체 클립 선택 ─────────────────────────
  async selectAllClips() {
    const page = this.page;
    // Ctrl+A로 전체 선택
    await page.evaluate(() => {
      // 키보드 이벤트를 직접 발생
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'a', ctrlKey: true, bubbles: true }));
    });
    await this._sleep(500);
    this.log('전체 클립 선택 (Ctrl+A)');
  }

  // ─── AI 더빙 적용 ───────────────────────────
  async applyDubbing(config) {
    await this.connector.ensureConnected();
    const page = this.page;

    this.log(`AI 더빙 적용: 성우=${config.speakerName}`);

    // Step 1: 모달 닫기
    await this.dismissModals();

    // Step 2: AI 목소리 탭 클릭
    const tabClicked = await this.clickAiVoiceTab();
    if (!tabClicked) {
      throw new Error('AI 목소리 탭이 비활성 상태입니다. 파일을 먼저 열어주세요.');
    }

    // Step 3: 전체 클립 선택
    await this.selectAllClips();

    // Step 4: AI 목소리 패널에서 "AI 자막 더빙" 또는 "음성 다시 만들기" 찾기
    // Vrew DOM에서 확인된 요소: id="radix-9" text="AI 자막 더빙"
    this.log('AI 자막 더빙 메뉴 탐색...');

    const dubbingClicked = await page.evaluate(() => {
      // 방법 1: radix ID로 직접 접근
      const radix = document.getElementById('radix-9');
      if (radix && !radix.disabled) {
        radix.click();
        return 'radix-9';
      }

      // 방법 2: 텍스트로 찾기
      const allBtns = document.querySelectorAll('button, [role="button"], .dropdown-menu-trigger');
      for (const b of allBtns) {
        const t = b.textContent.trim();
        if ((t.includes('AI 자막 더빙') || t.includes('음성 만들기') || t.includes('다시 만들기')) &&
            !b.disabled && !b.classList.contains('disabled')) {
          b.click();
          return t;
        }
      }

      // 방법 3: 컨텍스트 메뉴에서 찾기
      const menuItems = document.querySelectorAll('.react-contextmenu-item');
      for (const item of menuItems) {
        const t = item.textContent.trim();
        if (t.includes('AI 자막 더빙') || t.includes('음성 덮어쓰기')) {
          item.click();
          return t;
        }
      }

      return false;
    });

    if (dubbingClicked) {
      this.log(`더빙 메뉴 클릭: "${dubbingClicked}"`);
      await this._sleep(2000);
    } else {
      this.log('더빙 메뉴를 찾지 못함 — AI 목소리 패널 내 서브메뉴 탐색 중...');
      // AI 목소리 패널이 열린 상태에서 추가 탐색
      const panelBtns = await page.evaluate(() => {
        return Array.from(document.querySelectorAll('button, [role="button"]'))
          .filter(b => b.offsetParent !== null)
          .map(b => b.textContent.trim().substring(0, 50))
          .filter(t => t);
      });
      this.log('현재 보이는 버튼: ' + panelBtns.join(', '));
    }

    // Step 5: 성우 선택 패널 처리
    await this._sleep(1000);
    await this.dismissModals(); // 더빙 관련 모달 처리

    // Step 6: 진행률 모니터링
    await this._monitorProgress();

    // Step 7: 저장
    await this.saveFile();

    this.log('AI 더빙 적용 완료!');
    this.emit('completed');
    if (this.win && !this.win.isDestroyed()) {
      this.win.webContents.send('vrew:completed');
    }
  }

  // ─── 진행률 모니터링 ────────────────────────
  async _monitorProgress() {
    const page = this.page;
    const startTime = Date.now();
    const MAX_WAIT = 5 * 60 * 1000;

    this.log('진행률 모니터링...');

    while (Date.now() - startTime < MAX_WAIT) {
      const status = await page.evaluate(() => {
        // 프로그레스 바 찾기
        const bar = document.querySelector('[role="progressbar"]');
        if (bar) {
          return {
            active: true,
            value: parseInt(bar.getAttribute('aria-valuenow') || '0'),
            max: parseInt(bar.getAttribute('aria-valuemax') || '100'),
          };
        }

        // 로딩 스피너
        const spinner = document.querySelector('[class*="loading"], [class*="spinner"], [class*="progress"]');
        if (spinner && spinner.offsetParent) return { active: true, value: -1, max: 100 };

        // 완료/에러 모달
        const modal = document.querySelector('.ReactModal__Overlay');
        if (modal) {
          const text = modal.textContent || '';
          if (text.includes('완료') || text.includes('success')) return { active: false, done: true };
          if (text.includes('에러') || text.includes('error') || text.includes('실패')) {
            return { active: false, error: text.substring(0, 200) };
          }
        }

        return { active: false };
      });

      if (status.error) {
        this.log(`에러 감지: ${status.error}`);
        await this.dismissModals();
        break;
      }

      if (status.done || (!status.active && Date.now() - startTime > 5000)) {
        this.progress(100, 100, '완료');
        break;
      }

      if (status.active && status.value >= 0) {
        this.progress(status.value, status.max, `더빙 중 ${status.value}%`);
      } else if (status.active) {
        this.progress(-1, 100, '더빙 처리 중...');
      }

      await this._sleep(1000);
    }

    await this.dismissModals();
  }

  // ─── 저장 ───────────────────────────────────
  async saveFile() {
    const page = this.page;
    this.log('파일 저장 (Ctrl+S)...');

    await page.evaluate(() => {
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 's', ctrlKey: true, bubbles: true }));
    });

    await this._sleep(2000);
    this.log('저장 완료');
  }

  // ─── 유틸리티 ────────────────────────────────
  _sleep(ms) {
    return new Promise(r => setTimeout(r, ms));
  }
}

module.exports = { VrewAutomator, DEFAULT_SPEAKERS };
