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

module.exports = { VAULT_DIR, ensureVault, getVaultDir, listItems, openInExplorer };
