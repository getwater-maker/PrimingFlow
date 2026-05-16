/**
 * 참조음성 보관소 — 사용자 데이터 폴더의 고정 위치.
 *
 * 위치: ~/.flow-app/ref-audio/
 *   ├─ 01_나레이션.wav
 *   ├─ 01_나레이션.txt   (대본 — 같은 이름)
 *   ├─ 02_고전책장.mp3
 *   ├─ 02_고전책장.txt
 *   └─ ...
 *
 * 성별 분리 폐지 — 사용자가 음성 들어보면 알 수 있으니 굳이 폴더 나눌 필요 없음.
 * 윈도우 탐색기로 이 폴더에 .wav/.mp3 + .txt 묶음을 두면 PrimingFlow 가 자동 인식.
 */

const fs = require('fs');
const path = require('path');
const os = require('os');
const { shell } = require('electron');
const { scanFolder } = require('./ref-audio-scanner');

const VAULT_DIR = path.join(os.homedir(), '.flow-app', 'ref-audio');

function ensureVault() {
  try { fs.mkdirSync(VAULT_DIR, { recursive: true }); }
  catch (e) { console.error('[ref-audio-vault] mkdir 실패:', e.message); }
  return VAULT_DIR;
}

function getVaultDir() {
  ensureVault();
  return VAULT_DIR;
}

/**
 * 보관소 안의 .wav/.mp3 + .txt 묶음 목록.
 * 옛 하위 폴더 (female/male) 도 함께 스캔 (마이그레이션 호환).
 */
function listItems() {
  ensureVault();
  const items = [...scanFolder(VAULT_DIR)];
  // 옛 하위 폴더 잔재 흡수
  for (const sub of ['female', 'male']) {
    const subDir = path.join(VAULT_DIR, sub);
    if (fs.existsSync(subDir)) {
      items.push(...scanFolder(subDir));
    }
  }
  return items;
}

function openInExplorer() {
  ensureVault();
  if (shell && typeof shell.openPath === 'function') {
    return shell.openPath(VAULT_DIR);
  }
  return Promise.resolve('shell unavailable');
}

/**
 * 파일명 안전화 — Windows/Unix 양쪽 금지 문자 제거, 공백 단정리, 확장자 제거.
 * 빈 문자열이면 'voice-design' 으로 대체.
 */
function _sanitizeBasename(name) {
  let s = String(name || '').trim();
  // 확장자 제거 (마지막 .xxx)
  s = s.replace(/\.[a-zA-Z0-9]{1,5}$/, '');
  // 윈도우 금지 문자 + 제어문자 제거
  s = s.replace(/[<>:"/\\|?*\x00-\x1f]/g, '_');
  // 연속 공백·언더스코어 정리
  s = s.replace(/\s+/g, ' ').trim();
  if (!s) s = 'voice-design';
  return s;
}

/** 보관소 내에 이미 같은 basename 의 wav/mp3 가 있으면 ` (2)`, ` (3)` ... 접미사 */
function _uniqueBasename(basename) {
  const exts = ['.wav', '.mp3', '.txt'];
  const taken = (suffix) => exts.some(ext => fs.existsSync(path.join(VAULT_DIR, basename + suffix + ext)));
  if (!taken('')) return basename;
  for (let i = 2; i < 1000; i++) {
    const suffix = ` (${i})`;
    if (!taken(suffix)) return basename + suffix;
  }
  return basename + '_' + Date.now();
}

/**
 * Voice Design 등으로 생성한 음성을 보관소에 저장.
 * @param {string} filename - 사용자가 입력한 이름 (확장자 무시)
 * @param {Buffer|Uint8Array} wavBuffer - WAV 바이트
 * @param {string} refText - 합성에 사용된 텍스트 (참조음성 대본으로 그대로 사용)
 * @param {object} [designMeta] - 선택적 sidecar — instruct + hyperparameter 묶음.
 *   주어지면 같은 basename 의 `.json` 파일로 함께 저장 → 이후 동일 hyperparameter 로 재합성 가능.
 *   예: { engine:'omnivoice', mode:'design', instruct, guidance_scale, position_temperature,
 *        class_temperature, denoise, duration, num_step, speed, seed, language, savedAt }
 * @returns {{ basename: string, wavPath: string, txtPath: string, metaPath?: string }}
 */
function saveItem(filename, wavBuffer, refText, designMeta) {
  ensureVault();
  const safe = _sanitizeBasename(filename);
  const basename = _uniqueBasename(safe);
  const wavPath = path.join(VAULT_DIR, basename + '.wav');
  const txtPath = path.join(VAULT_DIR, basename + '.txt');
  fs.writeFileSync(wavPath, Buffer.isBuffer(wavBuffer) ? wavBuffer : Buffer.from(wavBuffer));
  fs.writeFileSync(txtPath, String(refText || ''), 'utf8');

  const result = { basename, wavPath, txtPath };
  if (designMeta && typeof designMeta === 'object') {
    const metaPath = path.join(VAULT_DIR, basename + '.json');
    const meta = { savedAt: new Date().toISOString(), ...designMeta };
    fs.writeFileSync(metaPath, JSON.stringify(meta, null, 2), 'utf8');
    result.metaPath = metaPath;
  }
  return result;
}

/**
 * 보관소 아이템 1건의 sidecar(.json) 로드. 없으면 null.
 * Voice Design 으로 저장한 음성의 instruct + hyperparameter 복원에 사용.
 * @param {string} wavOrBasePath - .wav 절대경로 또는 basename
 * @returns {object|null}
 */
function loadMeta(wavOrBasePath) {
  if (!wavOrBasePath) return null;
  let metaPath;
  if (path.isAbsolute(wavOrBasePath)) {
    metaPath = wavOrBasePath.replace(/\.(wav|mp3|m4a|flac)$/i, '.json');
  } else {
    metaPath = path.join(VAULT_DIR, _sanitizeBasename(wavOrBasePath) + '.json');
  }
  try {
    if (fs.existsSync(metaPath)) {
      return JSON.parse(fs.readFileSync(metaPath, 'utf8'));
    }
  } catch (e) {
    console.error('[ref-audio-vault] meta 읽기 실패:', e.message);
  }
  return null;
}

module.exports = { VAULT_DIR, ensureVault, getVaultDir, listItems, openInExplorer, saveItem, loadMeta };
