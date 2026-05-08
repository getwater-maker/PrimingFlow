/**
 * AI 긴 문장 분할기 (8단계)
 *
 * 인터페이스:
 *   await splitLongSentenceAI(text, { maxChars, model, apiKey })
 *     → [{ text, weight }]
 *
 * 동작 우선순위:
 *   1. AI 모델 호출 (현재 Gemini 1.5 Flash — 무료 quota 충분)
 *   2. 실패 시 algo-splitter 폴백
 *   3. 그것도 실패 시 원본 1개 반환
 *
 * 비용·운영:
 *   - Gemini API key 가 secret-store 에 있어야 함 (TTS Gemini 와 같은 키 공유)
 *   - 호출 실패 (네트워크·rate limit·키 없음) 는 모두 알고리즘으로 폴백
 *   - 영구 무료 옵션을 우선 — 사용자 선호 반영
 */

const { splitLongSentenceAlgo, koSpeechWeight } = require('./algo-splitter');

// 'gemini-flash-latest' = Google 이 항상 최신 안정 flash 모델로 자동 매핑.
// 모델 deprecation 시에도 코드 변경 없이 자동 전환됨.
const DEFAULT_MODEL = 'gemini-flash-latest';

// 한 문장씩 호출 — 한 batch 로 묶을 수도 있지만 안정성·debugging 우선
const PROMPT_TEMPLATE = (text, maxChars) =>
  `다음 한국어 문장을 의미 단위로 자연스럽게 ${maxChars}자 이하로 나누세요.\n` +
  `- 의미가 끊기지 않도록 절·구 단위로 분할\n` +
  `- 분할된 각 부분이 자연스러운 한국어 문장이 되어야 함\n` +
  `- 결과는 줄바꿈으로 구분된 부분들만 출력 (설명 없음)\n` +
  `\n문장: ${text}`;

/**
 * @param {string} text
 * @param {object} opts
 *   - maxChars: 권장 최대 글자수 (기본 30)
 *   - apiKey: Gemini API 키 (없으면 알고리즘 폴백)
 *   - model: 'gemini-flash-latest' | 'gemini-2.5-flash' | ... (기본: 항상 최신)
 *   - timeout: 요청 timeout ms (기본 15000)
 *   - logger: (msg) => void
 * @returns {Promise<Array<{text:string, weight:number}>>}
 */
async function splitLongSentenceAI(text, opts = {}) {
  const maxChars = opts.maxChars || 30;
  const apiKey = opts.apiKey;
  const model = opts.model || DEFAULT_MODEL;
  const timeout = opts.timeout || 15000;
  const log = typeof opts.logger === 'function' ? opts.logger : () => {};

  if (!text || !text.trim()) return [];
  if (text.length <= maxChars) {
    return [{ text: text.trim(), weight: 1.0 }];
  }

  // API 키 없으면 즉시 알고리즘 폴백
  if (!apiKey) {
    log('[ai-splitter] API 키 없음 — 알고리즘 분할 사용');
    return splitLongSentenceAlgo(text, maxChars);
  }

  try {
    const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${apiKey}`;
    const body = {
      contents: [{ parts: [{ text: PROMPT_TEMPLATE(text, maxChars) }] }],
      generationConfig: {
        temperature: 0.3,
        maxOutputTokens: 512,
      },
    };

    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), timeout);

    let response;
    try {
      response = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
        signal: ctrl.signal,
      });
    } finally {
      clearTimeout(timer);
    }

    if (!response.ok) {
      const errText = await response.text().catch(() => '');
      log(`[ai-splitter] HTTP ${response.status} — 알고리즘 폴백 (${errText.substring(0, 100)})`);
      return splitLongSentenceAlgo(text, maxChars);
    }

    const data = await response.json();
    const raw = (data?.candidates?.[0]?.content?.parts?.[0]?.text || '').trim();

    if (!raw) {
      log('[ai-splitter] 응답 비어있음 — 알고리즘 폴백');
      return splitLongSentenceAlgo(text, maxChars);
    }

    // 줄바꿈 기준 파싱. 빈 줄·번호·기호 제거
    const lines = raw
      .split(/\r?\n/)
      .map(s => s.replace(/^\s*[\-•\d]+[\.\)]\s*/, '').trim())
      .filter(Boolean);

    if (lines.length < 2) {
      // AI 가 한 줄로만 답변 → 알고리즘 폴백
      log('[ai-splitter] 분할 결과 1개 — 알고리즘 폴백');
      return splitLongSentenceAlgo(text, maxChars);
    }

    // 가중치 = 한국어 발음 시간 가중치 비율 (받침/구두점 반영)
    const weights = lines.map(t => Math.max(0.1, koSpeechWeight(t)));
    const total = weights.reduce((s, w) => s + w, 0) || 1;
    return lines.map((t, i) => ({
      text: t,
      weight: weights[i] / total,
    }));
  } catch (e) {
    log(`[ai-splitter] 예외 — 알고리즘 폴백: ${e.message}`);
    return splitLongSentenceAlgo(text, maxChars);
  }
}

module.exports = { splitLongSentenceAI, DEFAULT_MODEL };
