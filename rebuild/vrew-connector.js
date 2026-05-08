/**
 * Vrew CDP Connector — Vrew Electron 앱에 Chrome DevTools Protocol로 연결
 *
 * Strategy A: 이미 열린 디버깅 포트 탐색
 * Strategy B: Vrew 재시작 with --remote-debugging-port
 */

const { chromium } = require('playwright');
const { spawn, execSync } = require('child_process');
const path = require('path');
const fs = require('fs');
const os = require('os');
const net = require('net');
const http = require('http');
const EventEmitter = require('events');

const DEBUG_PORT = 9222;
const PORT_SCAN_RANGE = [9222, 9223, 9224, 9225, 9226, 9227, 9228, 9229];

class VrewConnector extends EventEmitter {
  constructor(mainWindow) {
    super();
    this.win = mainWindow;
    this.browser = null;
    this.page = null;
    this.connected = false;
    this._port = null;
  }

  log(msg) {
    console.log(`[VrewConnector] ${msg}`);
    if (this.win && !this.win.isDestroyed()) {
      this.win.webContents.send('log', `[Vrew] ${msg}`);
    }
  }

  // ─── 메인 연결 ───────────────────────────────
  async connect() {
    if (this.connected) return { success: true, port: this._port };

    this.log('Vrew 연결 시작...');

    // Strategy A: 기존 디버깅 포트 탐색
    let portInfo = await this._findDebugPort();

    if (!portInfo) {
      // Strategy B: Vrew 재시작 with debug port
      this.log('디버깅 포트 없음 → Vrew 재시작 시도...');
      portInfo = await this._restartVrewWithDebug();
    }

    if (!portInfo) {
      throw new Error('Vrew 연결 실패. Vrew가 설치되어 있고 실행 중인지 확인해주세요.');
    }

    // Playwright CDP 연결
    await this._connectCDP(portInfo.port);

    this.connected = true;
    this._port = portInfo.port;
    this.emit('connected', { port: portInfo.port });
    this.log(`Vrew 연결 성공 (port: ${portInfo.port})`);

    return { success: true, port: portInfo.port };
  }

  async disconnect() {
    if (this.browser) {
      try { await this.browser.close(); } catch {}
      this.browser = null;
      this.page = null;
    }
    this.connected = false;
    this._port = null;
    this.emit('disconnected');
    this.log('Vrew 연결 해제');
  }

  async ensureConnected() {
    if (!this.connected || !this.page) {
      await this.connect();
    }
    // 페이지가 살아있는지 확인
    try {
      await this.page.title();
    } catch {
      this.connected = false;
      await this.connect();
    }
  }

  // ─── Strategy A: 포트 탐색 ───────────────────
  async _findDebugPort() {
    for (const port of PORT_SCAN_RANGE) {
      try {
        const data = await this._httpGet(`http://127.0.0.1:${port}/json/version`, 2000);
        const json = JSON.parse(data);
        // Electron/Vrew 확인
        if (json.Browser && (json.Browser.includes('Chrome') || json.Browser.includes('Electron'))) {
          this.log(`디버깅 포트 발견: ${port}`);
          return { port, wsUrl: json.webSocketDebuggerUrl };
        }
      } catch {
        continue;
      }
    }
    return null;
  }

  // ─── Strategy B: Vrew 재시작 ─────────────────
  async _restartVrewWithDebug(vrewFilePath) {
    const vrewPath = this._detectVrewPath();
    if (!vrewPath) {
      this.log('Vrew 설치 경로를 찾을 수 없습니다');
      return null;
    }

    this.log(`Vrew 경로: ${vrewPath}`);
    this._vrewExePath = vrewPath;

    // 기존 Vrew 프로세스 종료
    const killed = this._killVrewProcesses();
    if (killed) {
      this.log('기존 Vrew 프로세스 종료됨, 2초 대기...');
      await this._sleep(2000);
    }

    // 디버깅 포트로 재시작 (+ 파일 인자)
    const args = [
      `--remote-debugging-port=${DEBUG_PORT}`,
      '--remote-allow-origins=*'
    ];
    if (vrewFilePath) args.push(vrewFilePath);

    this.log(`Vrew 시작 (debug port: ${DEBUG_PORT})${vrewFilePath ? ' + 파일: ' + path.basename(vrewFilePath) : ''}...`);
    const child = spawn(vrewPath, args, {
      detached: true,
      stdio: 'ignore',
      windowsHide: false,
      cwd: path.dirname(vrewPath), // Vrew 설치 디렉토리에서 실행 (nodehun 경로 문제 방지)
    });
    child.unref();

    // 포트 준비 대기
    const ready = await this._waitForPort(DEBUG_PORT, 15000);
    if (!ready) {
      this.log('Vrew 시작 타임아웃');
      return null;
    }

    this.log('Vrew 시작 완료');
    return { port: DEBUG_PORT };
  }

  // ─── CLI 인자로 파일 열기 (이미 실행 중인 Vrew에) ─────
  async openFileViaCli(vrewFilePath) {
    const vrewPath = this._vrewExePath || this._detectVrewPath();
    if (!vrewPath) throw new Error('Vrew 경로를 찾을 수 없습니다');

    this.log(`CLI 파일 전달: ${path.basename(vrewFilePath)}`);
    // 이미 실행 중인 Vrew에 두 번째 인스턴스로 파일 경로 전달
    // Vrew는 "already up by another instance"로 첫 인스턴스에 파일을 넘기고 종료됨
    const child = spawn(vrewPath, [vrewFilePath], {
      detached: true,
      stdio: 'ignore',
    });
    child.unref();
    await this._sleep(3000); // 파일 로드 대기
  }

  // ─── CDP 연결 ───────────────────────────────
  async _connectCDP(port) {
    this.log(`CDP 연결 중 (port: ${port})...`);

    this.browser = await chromium.connectOverCDP(`http://127.0.0.1:${port}`);

    // Vrew 메인 페이지 찾기
    const contexts = this.browser.contexts();
    for (const ctx of contexts) {
      for (const pg of ctx.pages()) {
        try {
          const title = await pg.title();
          const hasRoot = await pg.$('#root');
          if (title === 'Vrew' || hasRoot) {
            this.page = pg;
            this.log(`Vrew 메인 페이지 발견 (title: ${title})`);
            break;
          }
        } catch { continue; }
      }
      if (this.page) break;
    }

    if (!this.page) {
      // 첫 번째 페이지라도 사용
      if (contexts.length > 0 && contexts[0].pages().length > 0) {
        this.page = contexts[0].pages()[0];
        this.log('메인 페이지 미확인 — 첫 번째 페이지 사용');
      } else {
        throw new Error('Vrew 페이지를 찾을 수 없습니다');
      }
    }

    // 페이지 닫힘 감지
    this.page.on('close', () => {
      this.connected = false;
      this.page = null;
      this.emit('disconnected');
      this.log('Vrew 페이지 닫힘');
    });
  }

  // ─── Vrew 경로 감지 ──────────────────────────
  _detectVrewPath() {
    const userHome = os.homedir();
    const candidates = [
      path.join(userHome, 'AppData', 'Local', 'Programs', 'vrew', 'Vrew.exe'),
      'C:\\Program Files\\Vrew\\Vrew.exe',
      'C:\\Program Files (x86)\\Vrew\\Vrew.exe',
      path.join(userHome, 'AppData', 'Local', 'vrew', 'Vrew.exe'),
    ];

    for (const p of candidates) {
      if (fs.existsSync(p)) return p;
    }

    // which/where로 시도
    try {
      const result = execSync('where Vrew.exe', { encoding: 'utf-8' }).trim();
      if (result && fs.existsSync(result.split('\n')[0])) {
        return result.split('\n')[0].trim();
      }
    } catch {}

    return null;
  }

  // ─── Vrew 프로세스 종료 ──────────────────────
  _killVrewProcesses() {
    try {
      execSync('taskkill /F /IM Vrew.exe', { stdio: 'ignore' });
      return true;
    } catch {
      return false; // 실행 중이 아닌 경우
    }
  }

  // ─── 유틸리티 ────────────────────────────────
  _httpGet(url, timeout = 3000) {
    return new Promise((resolve, reject) => {
      const req = http.get(url, { timeout }, (res) => {
        let data = '';
        res.on('data', chunk => data += chunk);
        res.on('end', () => resolve(data));
      });
      req.on('error', reject);
      req.on('timeout', () => { req.destroy(); reject(new Error('timeout')); });
    });
  }

  async _waitForPort(port, timeoutMs) {
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
      try {
        await this._httpGet(`http://127.0.0.1:${port}/json/version`, 1000);
        return true;
      } catch {
        await this._sleep(500);
      }
    }
    return false;
  }

  _sleep(ms) {
    return new Promise(r => setTimeout(r, ms));
  }
}

module.exports = { VrewConnector };
