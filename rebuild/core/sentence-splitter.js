/**
 * 한국어 텍스트 → 문장 배열
 *
 * 분할 규칙 (1문장 = 1클립 원칙):
 *   1. 마크다운 헤더 (#, ##, ###, ...) 줄은 통째 제거 (제목·소제목은 본문 아님)
 *   2. 따옴표/특수 인용부호는 모두 제거 (대화체에서 따옴표가 단독 문장이 되는 사고 방지)
 *   3. 빈 줄(\n\s*\n) 은 강제 단락 구분
 *   4. 한 단락 안의 단순 줄바꿈(\n)은 같은 문장의 일부 → 공백으로 변환
 *   5. 종결부호 (. ! ? 。) 기준 분할
 *   6. 종결부호 없이 단락이 끝나면 단락 전체가 한 문장 (긴 문장 → 8단계 AI 분할 대상)
 *
 * 변경 이력:
 *   - v1: 줄바꿈 우선 → 시·대화체에서 한 문장이 여러 줄로 잘림 (잘못)
 *   - v2: 종결부호 우선, 줄바꿈은 공백
 *   - v3: 마크다운 헤더 제거 + 따옴표 제거 (사용자 요청)
 */

// 다양한 따옴표/인용부호. 한국어 대본에서 자주 나오는 것들.
//   " " ' '  영문 직립
//   " " ' '  유니코드 곡선
//   『 』 「 」  일본·한국 인용
//   ‹ › « »  유럽
const QUOTE_CHARS = /["'""''‘’“”『』「」‹›«»]/g;

// 마크다운 헤더: 줄 시작 # ~ ###### + 공백 + 본문
const MARKDOWN_HEADER_LINE = /^\s{0,3}#{1,6}\s.*$/gm;

// 대괄호 섹션 마커: 줄 전체가 [텍스트] 인 경우만 인식 (인라인 제외)
const BRACKET_SECTION_RE = /^\s*\[([^\]]+?)\]\s*$/;

/**
 * 단락 텍스트 → 문장 배열 (내부 헬퍼)
 */
function _paragraphsToSentences(text) {
  let cleaned = text.replace(MARKDOWN_HEADER_LINE, '').replace(QUOTE_CHARS, '');
  const paragraphs = cleaned
    .split(/\r?\n\s*\r?\n+/)
    .map(p => p.trim())
    .filter(p => p.length > 0);

  const sentences = [];
  for (const para of paragraphs) {
    const flat = para.replace(/\r?\n/g, ' ').replace(/\s+/g, ' ').trim();
    if (!flat) continue;
    const matches = flat.match(/[^.!?。]+[.!?。]+|[^.!?。]+$/g);
    if (matches && matches.length > 0) {
      for (const m of matches) {
        const trimmed = m.trim();
        if (trimmed && /[가-힣A-Za-z0-9]/.test(trimmed)) sentences.push(trimmed);
      }
    } else {
      sentences.push(flat);
    }
  }
  return sentences;
}

/**
 * @param {string} text
 * @returns {string[]} 문장 텍스트 배열
 */
function splitIntoSentences(text) {
  if (!text || typeof text !== 'string' || !text.trim()) return [];
  return _paragraphsToSentences(text);
}

/**
 * 대괄호 섹션 마커를 인식하여 섹션별로 분할.
 * 각 문장에 sectionTitle 을 첨부해 반환.
 *
 * @param {string} text
 * @returns {{ items: Array<{text:string, sectionTitle:string|null}>, hasSections: boolean }}
 */
function splitWithSections(text) {
  if (!text || typeof text !== 'string' || !text.trim()) {
    return { items: [], hasSections: false };
  }

  const lines = text.split(/\r?\n/);
  const segments = []; // [{title, text}]
  let currentTitle = null;
  let lineBuffer = [];

  for (const line of lines) {
    const m = line.match(BRACKET_SECTION_RE);
    if (m) {
      segments.push({ title: currentTitle, text: lineBuffer.join('\n') });
      lineBuffer = [];
      currentTitle = m[1].trim();
    } else {
      lineBuffer.push(line);
    }
  }
  segments.push({ title: currentTitle, text: lineBuffer.join('\n') });

  const hasSections = segments.some(seg => seg.title !== null);

  const items = [];
  for (const seg of segments) {
    const sentenceTexts = _paragraphsToSentences(seg.text);
    for (const t of sentenceTexts) {
      items.push({ text: t, sectionTitle: seg.title });
    }
  }

  return { items, hasSections };
}

// 마크다운 헤더 + 헤더 텍스트 캡처 (도입부 자동 인식용)
const HEADER_LINE_CAPTURE = /^\s{0,3}#{1,6}\s+(.+?)\s*$/;

/**
 * 마크다운 헤더의 텍스트에 "도입" 이 들어있으면 그 헤더 이후 ~ 다음 헤더 전까지를
 * "도입부" 로 마킹. 헤더 자체는 sentence 에 포함되지 않음 (기존 동작과 동일).
 *
 * 예시:
 *   # 도입부
 *   첫 도입 문장입니다.
 *   두 번째 도입 문장입니다.
 *
 *   ## 1장 시작
 *   본론 첫 문장입니다.
 *
 *   → items: [
 *       { text: "첫 도입 문장입니다.",   isIntro: true },
 *       { text: "두 번째 도입 문장입니다.", isIntro: true },
 *       { text: "본론 첫 문장입니다.",   isIntro: false },
 *     ], hasIntro: true
 *
 * @param {string} text
 * @returns {{ items: Array<{text:string, isIntro:boolean}>, hasIntro: boolean }}
 */
function splitIntoSentencesWithIntro(text) {
  if (!text || typeof text !== 'string' || !text.trim()) {
    return { items: [], hasIntro: false };
  }
  const lines = text.split(/\r?\n/);

  // 줄들을 헤더 기준으로 블록 분할 → 각 블록에 isIntro 플래그
  const blocks = [];
  let curIntro = false;
  let curLines = [];
  const flush = () => {
    if (curLines.length > 0) blocks.push({ isIntro: curIntro, lines: curLines });
  };
  for (const line of lines) {
    const m = line.match(HEADER_LINE_CAPTURE);
    if (m) {
      flush();
      curIntro = /도입/.test(m[1]);   // 헤더 텍스트에 "도입" 이 있으면 도입부 시작
      curLines = [];
    } else {
      curLines.push(line);
    }
  }
  flush();

  const items = [];
  let hasIntro = false;
  for (const blk of blocks) {
    const blockText = blk.lines.join('\n');
    const sents = _paragraphsToSentences(blockText);
    for (const t of sents) items.push({ text: t, isIntro: blk.isIntro });
    if (blk.isIntro && sents.length > 0) hasIntro = true;
  }
  return { items, hasIntro };
}

module.exports = { splitIntoSentences, splitWithSections, splitIntoSentencesWithIntro };
