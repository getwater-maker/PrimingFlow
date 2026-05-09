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
const Usage = require('../../tts/gemini-usage-store');
const { quietPostJson } = require('../../tts/quiet-http');

// 'gemini-flash-latest' = Google 이 항상 최신 안정 flash 모델로 자동 매핑.
// 모델 deprecation 시에도 코드 변경 없이 자동 전환됨.
const DEFAULT_MODEL = 'gemini-flash-latest';

// Circuit breaker — 한 번 429 받으면 60초간 Gemini 호출 자체 스킵.
// 일일 quota 초과 상황에서 30+ 문장 연속 호출하다 모두 429 받는 일을 방지.
// 각 호출이 즉시 algo 폴백 → 네트워크 round-trip 자체 안 함.
let _gemini429Until = 0;
const CIRCUIT_BREAKER_MS = 60_000;

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

  // Circuit breaker — 최근 429 받았으면 60초간 호출 자체 스킵
  if (_gemini429Until > Date.now()) {
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

    // quietPostJson — fetch 대신 Node http 사용 (DevTools 콘솔에 빨간 에러 안 찍힘)
    const response = await quietPostJson(url, body, { timeoutMs: timeout });

    if (!response.ok) {
      if (response.status === 429) {
        Usage.bump('split_429');
        _gemini429Until = Date.now() + CIRCUIT_BREAKER_MS;
        log(`[ai-splitter] Gemini 429 (일일 quota 초과) — 60초간 algo 분할로 직행`);
      } else {
        const errText = await response.text().catch(() => '');
        log(`[ai-splitter] HTTP ${response.status} — 알고리즘 폴백 (${errText.substring(0, 100)})`);
      }
      return splitLongSentenceAlgo(text, maxChars);
    }

    const data = await response.json();
    const raw = (data?.candidates?.[0]?.content?.parts?.[0]?.text || '').trim();

    if (!raw) {
      log('[ai-splitter] 응답 비어있음 — 알고리즘 폴백');
      return splitLongSentenceAlgo(text, maxChars);
    }

    Usage.bump('split_ok');

    // 줄바꿈 기준 파싱. 빈 줄·번호·기호 제거
    const lines = raw
      .split(/\r?\n/)
      .map(s => s.replace(/^\s*[\-•\d]+[\.\)]\s*/, '').trim())
      .filter(Boolean);

    // (1) 줄 끝의 메타 표시 제거 — Gemini 가 종종 "텍스트 (15)" 또는 "텍스트 - 15자" 식으로 출력
    //     이걸 안 떼면 sub-clip 자막에 "(15)" 같은 글자수 표시가 그대로 박힘.
    const META_TAIL = /\s*[\(\[]\s*\d+\s*[자글자\s]*\s*[\)\]]\s*$|\s*[-–—]\s*\d+\s*[자글자]?\s*$/;
    const cleaned = lines
      .map(s => s.replace(META_TAIL, '').trim())
      .filter(Boolean);

    if (cleaned.length < 2) {
      // AI 가 한 줄로만 답변 → 알고리즘 폴백
      log('[ai-splitter] 분할 결과 1개 — 알고리즘 폴백');
      return splitLongSentenceAlgo(text, maxChars);
    }

    // (2) 검증 — 분할된 텍스트들의 합이 원본과 (공백·구두점 무시) 같은지 확인
    //     "시아버지" 가 "시아버" 로 잘리거나, AI 가 글자를 추가/누락하면 검증 실패 → algo 폴백.
    //     이 검증이 sub-clip 자막이 원본 대본과 한 글자라도 달라지는 것을 차단하는 안전장치.
    const _normalize = (s) => String(s).replace(/[\s,.!?;:()\[\]"'。、・·…\-–—]/g, '');
    const reconstituted = _normalize(cleaned.join(''));
    const original = _normalize(text);
    if (reconstituted !== original) {
      log(`[ai-splitter] 검증 실패 (원본과 다름) — algo 폴백. orig=${original.length}자 vs ai=${reconstituted.length}자`);
      return splitLongSentenceAlgo(text, maxChars);
    }

    // (3) 가중치 = 한국어 발음 시간 가중치 비율 (받침/구두점 반영)
    const weights = cleaned.map(t => Math.max(0.1, koSpeechWeight(t)));
    const total = weights.reduce((s, w) => s + w, 0) || 1;
    return cleaned.map((t, i) => ({
      text: t,
      weight: weights[i] / total,
    }));
  } catch (e) {
    log(`[ai-splitter] 예외 — 알고리즘 폴백: ${e.message}`);
    return splitLongSentenceAlgo(text, maxChars);
  }
}

module.exports = { splitLongSentenceAI, DEFAULT_MODEL };
