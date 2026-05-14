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

require('./main');
