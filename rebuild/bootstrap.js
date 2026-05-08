'use strict';

/**
 * Electron 진입점.
 * 가장 먼저 startup-logger 를 켜서 이후 모든 stdout/stderr/console 출력이
 * ~/.flow-app/logs/ 아래 파일에 기록되도록 한 뒤 기존 main.js (난독화) 를 로드한다.
 */

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
