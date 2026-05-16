/**
 * OmniVoice /asr-upload 클라이언트.
 * 음성 파일을 multipart 로 업로드해 Whisper STT 텍스트를 받는다.
 *
 * 메모리 정책: OmniVoice 가 PrimingFlow 의 근간 엔진. 백엔드 다운 시 다른 엔진
 * 자동 fallback 추가 금지 — 사용자가 OmniVoice 를 살리도록 명시 안내.
 */

const fs = require('fs');
const path = require('path');
const { getProvider } = require('./tts-config');

function _baseUrl() {
  const p = getProvider('omnivoice');
  return (p && p.baseUrl) ? p.baseUrl.replace(/\/+$/, '') : '';
}

/**
 * /asr/status — Whisper 로드 여부 + 백엔드 도달 가능성. 실패해도 transcribe 는 시도 가능.
 */
async function checkAsrStatus() {
  const base = _baseUrl();
  if (!base) return { loaded: false, reachable: false };
  try {
    const res = await fetch(base + '/asr/status', { method: 'GET' });
    if (!res.ok) return { loaded: false, reachable: true };
    const j = await res.json();
    return { loaded: !!j.loaded, reachable: true };
  } catch (_) {
    return { loaded: false, reachable: false };
  }
}

/**
 * 음성 파일 → 텍스트.
 * @param {string} audioPath - 로컬 음성 파일 절대경로 (wav/mp3/m4a/flac)
 * @param {{ timeoutMs?: number }} [opts] - 기본 600초 (Whisper 첫 로드 시 5분+ 소요)
 * @returns {Promise<string>}
 */
async function transcribe(audioPath, opts = {}) {
  if (!audioPath || !fs.existsSync(audioPath)) {
    throw new Error('오디오 파일이 없습니다: ' + audioPath);
  }
  const base = _baseUrl();
  if (!base) {
    throw new Error('OmniVoice baseUrl 미설정 — 서버 설정에서 URL 을 지정하세요.');
  }
  const url = base + '/asr-upload';
  const timeoutMs = (typeof opts.timeoutMs === 'number' && opts.timeoutMs > 0) ? opts.timeoutMs : 600000;

  const buf = fs.readFileSync(audioPath);
  const filename = path.basename(audioPath);
  const blob = new Blob([buf]);
  const form = new FormData();
  form.append('file', blob, filename);

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, { method: 'POST', body: form, signal: controller.signal });
    if (!res.ok) {
      let detail = '';
      try { detail = await res.text(); } catch (_) {}
      throw new Error(`OmniVoice /asr-upload HTTP ${res.status} — ${detail.slice(0, 300) || res.statusText}`);
    }
    const j = await res.json();
    return String(j.text || '');
  } catch (e) {
    if (e && e.name === 'AbortError') {
      throw new Error('STT 타임아웃 — OmniVoice 응답이 늦습니다. Whisper 첫 호출 시 5분+ 걸릴 수 있어요.');
    }
    throw new Error(`STT 실패: ${e.message}\n→ OmniVoice 백엔드(${base})가 켜져있고 /asr-upload 가 가능한지 확인하세요.`);
  } finally {
    clearTimeout(timer);
  }
}

module.exports = { transcribe, checkAsrStatus };
