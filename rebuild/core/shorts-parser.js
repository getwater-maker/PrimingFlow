/**
 * shorts-parser — 쇼츠대본(.md) 전용 파서
 *
 * 입력 형식 (예: [18_월] 쇼츠대본.md):
 *   ## 쇼츠 1 — 제목
 *   - 훅 자막(첫 프레임): `줄1 / 줄2`
 *   - 컷 리스트 (문장 = 자막 = 9:16 이미지 1컷):
 *     ① (훅) "나레이션 문장."
 *        `9:16 aspect ratio, ... 영어 이미지 프롬프트`
 *     ② (본론) "..."
 *        `...`
 *     ... (재훅) (CTA)
 *   ## 쇼츠 2 — ...
 *
 * 변환 규칙:
 *   - 한 파일에 3개(이상) 쇼츠가 함께 있음 → 하나의 프로젝트로 합치되 그룹 제목으로 구분.
 *   - (훅)/(본론)/(재훅)/(CTA) 뒤 "문장" = TTS+자막 단위 = 1 Sentence.
 *   - 각 컷의 바로 다음 백틱(`...`) 줄 = 그 컷의 이미지 프롬프트 (1 문장 = 1 이미지 = 1 Group).
 *   - 훅 자막(첫 프레임)은 별도 이미지가 없어 컷으로 만들지 않고 shorts 메타(hook)로 보관.
 *
 * 출력: { sentences, groups, shorts } — 기존 project 모델과 호환 (group.imagePrompt 채움).
 */

const { Sentence, Group, makeSentenceIder, finalizeGroupIds } = require('./project-model');

const _SECTION_RE  = /^\s*#{1,3}\s*쇼츠\s*(\d+)\s*(?:[—\-–:]\s*(.*))?$/;
// 나레이션 = 첫 큰따옴표 ~ 줄 끝 마지막 큰따옴표 사이 전체 (greedy + $ 앵커).
// → 안쪽에 작은따옴표 '...' 든 큰따옴표 "..." 든 다 포함해서 끝까지 잡음.
const _CUT_RE      = /\((훅|본론|재훅|CTA)\)\s*["“”](.+)["“”]\s*$/;
// 마커는 있는데 큰따옴표 매칭이 안 된 줄 감지용 (조용한 누락 방지 경고)
const _MARKER_RE   = /\((훅|본론|재훅|CTA)\)/;
const _HOOK_RE     = /훅\s*자막[^:：]*[:：]\s*`([^`]+)`/;
const _BACKTICK_RE = /^\s*`(.+?)`\s*$/;

/** 텍스트가 쇼츠대본 형식인지 — `## 쇼츠 N` 섹션 + (훅)/(본론)/... 마커 존재. */
function isShortsScript(text) {
  if (!text) return false;
  const t = String(text);
  return /^\s*#{1,3}\s*쇼츠\s*\d+/m.test(t) && /\((훅|본론|재훅|CTA)\)/.test(t);
}

/**
 * 쇼츠대본 텍스트 → { sentences, groups, shorts }.
 *   sentences: Sentence[] (각 컷 = 1 문장, TTS+자막)
 *   groups:    Group[]    (1 문장 = 1 그룹, imagePrompt = 백틱 9:16 프롬프트, title 로 쇼츠 구분)
 *   shorts:    [{ num, title, hook }]  (훅 자막 첫 프레임 포함 메타)
 */
function parseShortsScript(text) {
  const lines = String(text).replace(/\r\n/g, '\n').split('\n');

  // ── 1단계: 구조 파싱 → shorts[{num,title,hook,cuts:[{marker,text,prompt}]}] ──
  const shorts = [];
  const warnings = [];     // 마커는 있으나 파싱 실패한 줄 (조용한 누락 방지)
  let cur = null;          // 현재 쇼츠
  let pendingCut = null;   // 이미지 프롬프트를 기다리는 직전 컷
  for (const line of lines) {
    const sec = line.match(_SECTION_RE);
    if (sec) {
      cur = { num: parseInt(sec[1], 10), title: (sec[2] || '').trim(), hook: '', cuts: [] };
      shorts.push(cur);
      pendingCut = null;
      continue;
    }
    const hook = line.match(_HOOK_RE);
    if (hook) { if (cur) cur.hook = hook[1].trim(); continue; }

    const cut = line.match(_CUT_RE);
    if (cut && cur) {
      const narration = cut[2].trim();
      if (narration) { pendingCut = { marker: cut[1], text: narration, prompt: '' }; cur.cuts.push(pendingCut); }
      continue;
    }
    // 마커(훅/본론/재훅/CTA)는 있는데 큰따옴표 매칭이 안 됨 → 누락 경고 (따옴표 누락/오타 등)
    if (cur && _MARKER_RE.test(line)) { warnings.push(line.trim().slice(0, 60)); continue; }

    const bt = line.match(_BACKTICK_RE);
    if (bt && pendingCut && !pendingCut.prompt) { pendingCut.prompt = bt[1].trim(); pendingCut = null; }
  }

  // ── 2단계: Sentence/Group 빌드 ──
  // 각 쇼츠 = [훅 자막 컷(있으면) + 마커 컷들]. 훅 자막은 첫 프레임 — TTS+자막(2줄), 이미지는 첫 컷 재사용.
  const sid = makeSentenceIder();
  const sentences = [];
  const groups = [];

  for (const sh of shorts) {
    if (!sh.cuts.length) continue;
    const ordered = [];
    if (sh.hook) {
      // 훅 자막(첫 프레임) — TTS+자막 첫 컷. '/'(2줄 의도)는 TTS 안정성 위해 공백으로 합침.
      // 이미지는 첫 마커 컷 프롬프트 재사용(첫 프레임 = 오프닝 장면).
      ordered.push({ marker: '훅자막', text: sh.hook.replace(/\s*\/\s*/g, ' ').trim(), prompt: sh.cuts[0].prompt, isHook: true });
    }
    sh.cuts.forEach(c => ordered.push(c));

    ordered.forEach((c, i) => {
      const s = new Sentence({ id: sid(c.text), num: sentences.length + 1, text: c.text });
      const g = new Group({ id: 'tmp', num: groups.length + 1, sentenceIds: [s.id] });
      g.title = (i === 0)
        ? `🎬 쇼츠 ${sh.num}${sh.title ? ' — ' + sh.title : ''}`
        : `쇼츠 ${sh.num} · ${c.marker}`;
      g.isBracket = true;
      g.shortsNum = sh.num;        // 어느 쇼츠(편)인지 — 작업목록 색상 구분·편별 미리듣기용
      if (c.prompt) g.imagePrompt = c.prompt;
      sentences.push(s);
      groups.push(g);
    });
  }

  finalizeGroupIds(groups, sentences);
  return { sentences, groups, shorts, warnings };
}

module.exports = { isShortsScript, parseShortsScript };
