'use strict';

/**
 * Flow 시작 로그 저장기.
 *
 * 프로세스가 켜진 직후 한 번 init() 을 호출해두면
 * 이후의 모든 console.* / process.stdout.write / process.stderr.write
 * 출력과 uncaughtException / unhandledRejection 이
 * ~/.flow-app/logs/flow-<timestamp>-<tag>-<pid>.log 에 그대로 쌓인다.
 *
 * 메인 프로세스: bootstrap.js 가 init('main') 을 호출.
 * 렌더러 프로세스: index.html 가 initRenderer() 를 호출.
 */

const fs   = require('fs');
const path = require('path');
const os   = require('os');

const LOG_DIR    = path.join(os.homedir(), '.flow-app', 'logs');
const KEEP_FILES = 30;

let initialized = false;
let stream      = null;
let logPath     = null;
let tagGlobal   = 'main';

function pad(n)    { return String(n).padStart(2, '0'); }
function nowIso()  { return new Date().toISOString(); }
function tsLabel() {
  const d = new Date();
  return `${d.getFullYear()}-${pad(d.getMonth()+1)}-${pad(d.getDate())}` +
         `T${pad(d.getHours())}-${pad(d.getMinutes())}-${pad(d.getSeconds())}`;
}

function ensureDir() {
  try { fs.mkdirSync(LOG_DIR, { recursive: true }); } catch (_) {}
}

function rotateOldLogs() {
  try {
    const files = fs.readdirSync(LOG_DIR)
      .filter(f => f.startsWith('flow-') && f.endsWith('.log'))
      .map(f => {
        const full = path.join(LOG_DIR, f);
        let mtime = 0;
        try { mtime = fs.statSync(full).mtimeMs; } catch (_) {}
        return { full, mtime };
      })
      .sort((a, b) => b.mtime - a.mtime);
    files.slice(KEEP_FILES).forEach(({ full }) => {
      try { fs.unlinkSync(full); } catch (_) {}
    });
  } catch (_) {}
}

function buildLogPath(tag) {
  return path.join(LOG_DIR, `flow-${tsLabel()}-${tag}-${process.pid}.log`);
}

function safeWrite(text) {
  if (!stream) return;
  try { stream.write(text); } catch (_) {}
}

function syncAppend(text) {
  if (!logPath) return;
  try { fs.appendFileSync(logPath, text); } catch (_) {}
}

function patchStream(streamObj, tag) {
  const original = streamObj.write.bind(streamObj);
  let needPrefix = true;
  streamObj.write = function (chunk, encoding, cb) {
    try {
      if (chunk && stream) {
        const text = Buffer.isBuffer(chunk)
          ? chunk.toString(typeof encoding === 'string' ? encoding : 'utf8')
          : typeof chunk === 'string' ? chunk : String(chunk);
        const lines = text.split('\n');
        let out = '';
        for (let i = 0; i < lines.length; i++) {
          const last = i === lines.length - 1;
          if (needPrefix && (lines[i].length > 0 || !last)) {
            out += `[${nowIso()}] [${tag}] `;
            needPrefix = false;
          }
          out += lines[i];
          if (!last) {
            out += '\n';
            needPrefix = true;
          }
        }
        if (out) safeWrite(out);
      }
    } catch (_) {}
    return original(chunk, encoding, cb);
  };
}

function attachProcessHandlers(tag) {
  process.on('uncaughtException', (err) => {
    const line = `[${nowIso()}] [${tag}] [UNCAUGHT] ${err && err.stack ? err.stack : err}\n`;
    safeWrite(line);
    syncAppend(line);
  });
  process.on('unhandledRejection', (reason) => {
    const line = `[${nowIso()}] [${tag}] [UNHANDLED] ${reason && reason.stack ? reason.stack : reason}\n`;
    safeWrite(line);
    syncAppend(line);
  });
  process.on('exit', (code) => {
    safeWrite(`[${nowIso()}] [${tag}] [EXIT] code=${code}\n`);
  });
}

function init(tag) {
  if (initialized) return logPath;
  initialized = true;
  tagGlobal = tag || 'main';

  ensureDir();
  rotateOldLogs();
  logPath = buildLogPath(tagGlobal);

  try {
    stream = fs.createWriteStream(logPath, { flags: 'a' });
    stream.on('error', () => { stream = null; });
  } catch (_) {
    stream = null;
  }

  const header =
    `\n========== Flow log start (${tagGlobal}) @ ${nowIso()} | pid=${process.pid} ==========\n` +
    `node=${process.versions.node} ` +
    `electron=${process.versions.electron || '-'} ` +
    `chrome=${process.versions.chrome || '-'} ` +
    `platform=${process.platform} arch=${process.arch}\n` +
    `cwd=${process.cwd()}\n` +
    `argv=${JSON.stringify(process.argv)}\n` +
    `--------------------------------------------------------------------\n`;
  safeWrite(header);

  patchStream(process.stdout, `${tagGlobal}:out`);
  patchStream(process.stderr, `${tagGlobal}:err`);
  attachProcessHandlers(tagGlobal);

  return logPath;
}

function initRenderer() { return init('renderer'); }
function getLogPath()   { return logPath; }
function getLogDir()    { return LOG_DIR; }

module.exports = { init, initRenderer, getLogPath, getLogDir };
