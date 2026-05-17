'use strict';

/**
 * Electron 진입점.
 * 가장 먼저 startup-logger 를 켜서 이후 모든 stdout/stderr/console 출력이
 * ~/.flow-app/logs/ 아래 파일에 기록되도록 한 뒤 기존 main.js (난독화) 를 로드한다.
 */

// disk-cache-dir 스위치 — 기본 캐시 위치 권한 에러(`Unable to move the cache: 액세스가 거부되었습니다`) 회피.
// main.js 가 app.ready 처리하기 전이라 여기서 등록한 스위치는 유효함.
try {
  const { app } = require('electron');
  const path = require('path');
  const os = require('os');
  const fs = require('fs');
  const cacheDir = path.join(os.homedir(), '.flow-app', 'electron-cache');
  try { fs.mkdirSync(cacheDir, { recursive: true }); } catch {}
  app.commandLine.appendSwitch('disk-cache-dir', cacheDir);
  process.stdout.write(`[bootstrap] disk-cache-dir=${cacheDir}\n`);
} catch (err) {
  process.stderr.write(`[bootstrap] disk-cache-dir setup failed: ${err && err.stack ? err.stack : err}\n`);
}

try {
  const logger = require('./startup-logger');
  const logPath = logger.init('main');
  process.stdout.write(`[startup-logger] file=${logPath}\n`);
} catch (err) {
  process.stderr.write(`[startup-logger] init failed: ${err && err.stack ? err.stack : err}\n`);
}

// 자동 업데이트 체크 등록 — main.js (난독화) 가 app.whenReady 처리 후 동작
try {
  require('./auto-updater').setupAutoUpdater();
} catch (err) {
  process.stderr.write(`[auto-updater] setup failed: ${err && err.stack ? err.stack : err}\n`);
}

// 표준 다이얼로그 IPC (main.js 난독화로 등록되지 않은 핸들러)
try {
  const { ipcMain, dialog, BrowserWindow } = require('electron');
  ipcMain.handle('show-save-dialog', async (event, options) => {
    const win = BrowserWindow.fromWebContents(event.sender);
    return win
      ? await dialog.showSaveDialog(win, options || {})
      : await dialog.showSaveDialog(options || {});
  });
  // 프로젝트 불러오기 — defaultPath 지원되는 file open dialog 가 필요
  ipcMain.handle('show-open-dialog', async (event, options) => {
    const win = BrowserWindow.fromWebContents(event.sender);
    return win
      ? await dialog.showOpenDialog(win, options || {})
      : await dialog.showOpenDialog(options || {});
  });
} catch (err) {
  process.stderr.write(`[ipc] dialog handlers failed: ${err && err.stack ? err.stack : err}\n`);
}

require('./main');
