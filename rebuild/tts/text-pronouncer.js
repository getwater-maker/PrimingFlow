/**
 * OmniVoice 합성 직전 텍스트 발음 치환
 * - 프로젝트 사전 우선, 글로벌 사전 후순위
 * - 같은 source 면 프로젝트 사전이 우선
 * - source 길이가 긴 항목 먼저 매칭 (substring 치환 순서 보장)
 */

'use strict';

/**
 * @param {string} text        원본 텍스트
 * @param {Array}  globalDict  [{source, pron, enabled}]  글로벌 사전
 * @returns {string}
 */
function applyOmniVoiceDict(text, globalDict) {
  const entries = (globalDict || []).filter(e => e.source && e.pron && e.enabled !== false);
  // 긴 source 먼저 매칭
  entries.sort((a, b) => b.source.length - a.source.length);
  let out = String(text || '');
  for (const { source, pron } of entries) {
    out = out.split(source).join(pron);
  }
  return out;
}

/**
 * TTS 합성 직전 일반 정규화 — 사전과 무관하게 항상 적용.
 * - 숫자 ~ 숫자  →  숫자에서 숫자  (반각 ~ / wave dash 〜 / 전각 ～ 모두 처리)
 *   예: "50~60명" → "50에서 60명"  (TTS가 "오십에서 육십 명"으로 자연스럽게 읽음)
 */
function normalizeForTTS(text) {
  let out = String(text || '');
  out = out.replace(/(\d+)\s*[~〜～]\s*(\d+)/g, '$1에서 $2');
  return out;
}

module.exports = { applyOmniVoiceDict, normalizeForTTS };
