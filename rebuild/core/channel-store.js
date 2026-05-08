/**
 * 채널 프리셋 — 유튜브 채널별 작업 설정 묶음
 * 위치: ~/.flow-app/channels.json
 *
 * 한 채널 = 한 워크플로:
 *   - 어떤 TTS 프리셋 (음성)
 *   - 어떤 참조음성 폴더 + 파일
 *   - TTS 속도
 *   - 출력 폴더
 *   - vrew 로고 이미지
 *   - Google 계정 프로필
 *   - 음색 지시문 (선택)
 *
 * 채널 데이터 구조:
 *   {
 *     id: 'ch_xxx',
 *     name: '다산의 뜸',
 *     ttsPresetId: 'p_voxcpm_default',  // tts-presets 의 어느 프리셋
 *     refAudioFolder: 'C:/.../참조음성',     // 이 안에 WAV+TXT 묶음
 *     selectedRefAudio: '01_고전책장.wav',   // 폴더 안에서 선택된 파일명
 *     speed: 0.9,
 *     outputFolder: 'D:/Output/다산의뜸',
 *     logoPath: 'D:/.../logo.png',
 *     profileId: 'default',
 *     instruct: '',  // Voice Design (선택)
 *   }
 */

const fs = require('fs');
const path = require('path');
const os = require('os');

const STORE_DIR = path.join(os.homedir(), '.flow-app');
const STORE_PATH = path.join(STORE_DIR, 'channels.json');

function loadAll() {
  try {
    if (fs.existsSync(STORE_PATH)) {
      const data = JSON.parse(fs.readFileSync(STORE_PATH, 'utf-8'));
      if (Array.isArray(data)) return data;
    }
  } catch (e) {
    console.error('[channel-store] 로드 실패:', e.message);
  }
  return [];
}

function saveAll(channels) {
  try {
    fs.mkdirSync(STORE_DIR, { recursive: true });
    fs.writeFileSync(STORE_PATH, JSON.stringify(channels, null, 2), 'utf-8');
    return true;
  } catch (e) {
    console.error('[channel-store] 저장 실패:', e.message);
    return false;
  }
}

function getById(id) {
  return loadAll().find(c => c.id === id) || null;
}

function add(channel) {
  if (!channel.id) channel.id = 'ch_' + Date.now() + '_' + Math.random().toString(36).slice(2, 6);
  const all = loadAll();
  all.push(channel);
  saveAll(all);
  return channel;
}

function update(id, patch) {
  const all = loadAll();
  const idx = all.findIndex(c => c.id === id);
  if (idx < 0) return null;
  all[idx] = { ...all[idx], ...patch };
  saveAll(all);
  return all[idx];
}

function remove(id) {
  const all = loadAll();
  const filtered = all.filter(c => c.id !== id);
  saveAll(filtered);
  return true;
}

module.exports = { loadAll, getById, add, update, remove, STORE_PATH };
