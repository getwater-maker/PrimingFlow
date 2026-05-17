/**
 * 문장 배열 → 그룹 배열
 *
 * 그룹화 규칙:
 *   1. 그룹 크기 N 만큼 정상 문장을 묶음 (단일 groupSize 또는 stages 배열)
 *   2. 짧은 문장 (charCount < shortLen) 은 새 그룹을 시작하지 않고 윗 그룹에 흡수
 *   3. 첫 문장이 짧은 경우 그래도 첫 그룹을 시작 (시드)
 *   4. 긴 문장 (charCount > longLen) 도 정상 처리 (그룹 카운트 1)
 *
 * stages 형식:
 *   [{ fromGroup: 1, toGroup: 6, sentenceSize: 5 }, { fromGroup: 7, toGroup: null, sentenceSize: 10 }]
 *   toGroup === null → 끝까지
 *
 * 예시 (N=3, shortLen=10):
 *   문장 1 (28자) → 그룹 1, count=1
 *   문장 2 (29자) → 그룹 1, count=2
 *   문장 3 (9자, 짧음) → 그룹 1 (흡수), count=2 유지
 *   문장 4 (30자) → 그룹 1, count=3 (가득)
 *   문장 5 (22자) → 그룹 2 (새 그룹), count=1
 *   ...
 */

const { Sentence, Group, makeSentenceIder, finalizeGroupIds } = require('./project-model');
const { splitLongSentenceAlgo } = require('./long-sentence-splitter/algo-splitter');

/**
 * sentence 의 vrewClips 결정 — 긴 문장이면 splitLongSentenceAlgo 로 분할.
 * thresholds.disableLongSplit=true 면 분할 안 함 (한 문장 = 한 sub-clip).
 */
function _buildVrewClips(text, isLong, vrewMaxChars, disableLongSplit) {
  if (!isLong || disableLongSplit) return [{ text: text, weight: 1.0 }];
  return splitLongSentenceAlgo(text, vrewMaxChars);
}

/**
 * 현재 그룹 번호에 해당하는 stage 의 sentenceSize 반환.
 * @param {Array<{fromGroup:number, toGroup:number|null, sentenceSize:number}>} stages
 * @param {number} gNum - 현재 그룹 번호 (1-based)
 */
function _sizeForGroup(stages, gNum) {
  for (const st of stages) {
    const to = st.toGroup == null ? Infinity : st.toGroup;
    if (gNum >= st.fromGroup && gNum <= to) return st.sentenceSize;
  }
  return stages[stages.length - 1].sentenceSize;
}

/**
 * thresholds.stages 또는 thresholds.groupSize 로부터 stages 배열 정규화.
 */
function _normalizeStages(thresholds) {
  if (thresholds.stages && thresholds.stages.length > 0) {
    return thresholds.stages;
  }
  return [{ fromGroup: 1, toGroup: null, sentenceSize: thresholds.groupSize || 3 }];
}

/**
 * @param {string[]} sentenceTexts - splitIntoSentences() 결과
 * @param {{
 *   groupSize?: number,
 *   stages?: Array<{fromGroup:number, toGroup:number|null, sentenceSize:number}>,
 *   shortLen: number,
 *   longLen: number,
 *   vrewMaxChars?: number
 * }} thresholds
 * @returns {{ sentences: Sentence[], groups: Group[] }}
 */
function buildGroups(sentenceTexts, thresholds) {
  const { shortLen, longLen } = thresholds;
  const vrewMaxChars = thresholds.vrewMaxChars || longLen;
  const disableLongSplit = !!thresholds.disableLongSplit;
  const stages = _normalizeStages(thresholds);

  // 1단계: Sentence 객체 생성 + 짧은/긴 문장 판정 + vrew 클립 자동 분할 (알고리즘)
  // id 는 콘텐츠 해시 기반 — 같은 text 면 같은 id, 같은 text 가 N 번째면 _N suffix.
  const sid = makeSentenceIder();
  const sentences = sentenceTexts.map((text, i) => {
    const s = new Sentence({ id: sid(text), num: i + 1, text });
    s.isShort = s.charCount < shortLen;
    s.isLong = s.charCount > longLen;

    // 8단계: 긴 문장은 알고리즘 분할로 vrewClips 미리 채움.
    // disableLongSplit=true 면 분할 안 함 (한 문장 = 한 자막 줄).
    s.vrewClips = _buildVrewClips(text, s.isLong, vrewMaxChars, disableLongSplit);
    return s;
  });

  // 2단계: 그룹화
  const groups = [];
  let gNum = 0;
  let currentGroup = null;
  let currentCount = 0;        // 정상·긴 문장 수 (짧은 문장 제외)

  const startNewGroup = () => {
    gNum++;
    currentGroup = new Group({ num: gNum, sentenceIds: [] });
    groups.push(currentGroup);
    currentCount = 0;
  };

  for (const s of sentences) {
    // 첫 그룹은 무조건 시작
    if (!currentGroup) startNewGroup();

    if (s.isShort && currentGroup.sentenceIds.length > 0) {
      // 짧은 문장이고 그룹에 이미 다른 문장 있음 → 흡수
      currentGroup.sentenceIds.push(s.id);
      s.groupId = currentGroup.id;
      // currentCount 유지 — 짧은 문장은 카운트 안 함
    } else {
      // 정상·긴 문장 또는 그룹의 첫 문장
      if (currentCount >= _sizeForGroup(stages, currentGroup.num)) {
        // 그룹 가득 참 → 새 그룹
        startNewGroup();
      }
      currentGroup.sentenceIds.push(s.id);
      s.groupId = currentGroup.id;
      currentCount++;
    }
  }

  finalizeGroupIds(groups, sentences);
  return { sentences, groups };
}

/**
 * 대괄호 섹션 마커가 있는 대본용 그룹화.
 * 같은 sectionTitle 이 연속하면 하나의 그룹.
 * 그룹 크기(groupSize) 옵션은 무시됨.
 *
 * @param {Array<{text:string, sectionTitle:string|null}>} items
 * @param {{ shortLen: number, longLen: number, vrewMaxChars?: number }} thresholds
 */
function buildGroupsWithSections(items, thresholds) {
  const { shortLen, longLen } = thresholds;
  const vrewMaxChars = thresholds.vrewMaxChars || longLen;
  const disableLongSplit = !!thresholds.disableLongSplit;

  const sid = makeSentenceIder();
  const sentences = items.map((item, i) => {
    const s = new Sentence({ id: sid(item.text), num: i + 1, text: item.text });
    s.sectionTitle = item.sectionTitle || null;
    s.isShort = s.charCount < shortLen;
    s.isLong = s.charCount > longLen;
    s.vrewClips = _buildVrewClips(item.text, s.isLong, vrewMaxChars, disableLongSplit);
    return s;
  });

  const groups = [];
  let gNum = 0;
  let currentGroup = null;
  let lastTitle = undefined;

  for (const s of sentences) {
    if (s.sectionTitle !== lastTitle) {
      gNum++;
      currentGroup = new Group({ num: gNum, sentenceIds: [] });
      currentGroup.title = s.sectionTitle;
      groups.push(currentGroup);
      lastTitle = s.sectionTitle;
    }
    currentGroup.sentenceIds.push(s.id);
    s.groupId = currentGroup.id;
  }

  finalizeGroupIds(groups, sentences);
  return { sentences, groups };
}

/**
 * 도입부/본론 분리 그룹화.
 * - 도입부 sentence 들끼리, 본론 sentence 들끼리 각각 다른 그룹 크기로 묶음.
 * - 도입↔본론 경계는 항상 새 그룹 시작 (같은 그룹에 섞이지 않음).
 *
 * @param {Array<{text:string, isIntro:boolean}>} items - splitIntoSentencesWithIntro() 결과
 * @param {{
 *   shortLen: number,
 *   longLen: number,
 *   introSentenceSize: number,   // 도입부 그룹 크기 (문장 수)
 *   mainSentenceSize: number,    // 본론 그룹 크기 (문장 수)
 *   vrewMaxChars?: number
 * }} thresholds
 * @returns {{ sentences: Sentence[], groups: Group[] }}
 */
function buildGroupsWithIntro(items, thresholds) {
  const { shortLen, longLen, introSentenceSize, mainSentenceSize } = thresholds;
  const vrewMaxChars = thresholds.vrewMaxChars || longLen;
  const disableLongSplit = !!thresholds.disableLongSplit;

  const sid = makeSentenceIder();
  const sentences = items.map((item, i) => {
    const s = new Sentence({ id: sid(item.text), num: i + 1, text: item.text });
    s.isShort = s.charCount < shortLen;
    s.isLong = s.charCount > longLen;
    s.isIntro = !!item.isIntro;
    s.vrewClips = _buildVrewClips(item.text, s.isLong, vrewMaxChars, disableLongSplit);
    return s;
  });

  const groups = [];
  let gNum = 0;
  let currentGroup = null;
  let currentCount = 0;
  let currentMode = null;       // 'intro' | 'main'

  const startNewGroup = (isIntro) => {
    gNum++;
    currentGroup = new Group({ num: gNum, sentenceIds: [] });
    currentGroup.isIntro = isIntro;
    groups.push(currentGroup);
    currentCount = 0;
    currentMode = isIntro ? 'intro' : 'main';
  };

  for (const s of sentences) {
    const targetMode = s.isIntro ? 'intro' : 'main';
    // 모드 변경 시 강제로 새 그룹 시작 (도입↔본론 경계는 절대 같은 그룹 X)
    if (!currentGroup || currentMode !== targetMode) {
      startNewGroup(s.isIntro);
    }
    const groupSize = s.isIntro
      ? (introSentenceSize || 2)
      : (mainSentenceSize || 3);

    if (s.isShort && currentGroup.sentenceIds.length > 0) {
      // 짧은 문장은 흡수
      currentGroup.sentenceIds.push(s.id);
      s.groupId = currentGroup.id;
    } else {
      if (currentCount >= groupSize) startNewGroup(s.isIntro);
      currentGroup.sentenceIds.push(s.id);
      s.groupId = currentGroup.id;
      currentCount++;
    }
  }
  finalizeGroupIds(groups, sentences);
  return { sentences, groups };
}

/**
 * 하이브리드 그룹화 — md 영역은 도입/본론 사이즈로, 대괄호 영역은 한 그룹씩.
 *
 * 동작:
 *  - mode='bracket' 문장: 같은 sectionTitle 끼리 한 그룹 (groupSize 무시)
 *  - mode='md' 문장: isIntro 면 introSentenceSize, 아니면 mainSentenceSize 로 그룹화
 *  - 모드 경계 (md→bracket 또는 bracket→md) 또는 대괄호 sectionTitle 변경 → 항상 새 그룹
 *  - 짧은 문장 (md 그룹에서만) 흡수 규칙은 기존 buildGroupsWithIntro 와 동일
 *
 * @param {Array<{text:string, mode:'md'|'bracket', isIntro:boolean, sectionTitle:string|null}>} items
 * @param {{
 *   shortLen: number,
 *   longLen: number,
 *   introSentenceSize: number,
 *   mainSentenceSize: number,
 *   vrewMaxChars?: number
 * }} thresholds
 */
function buildGroupsHybrid(items, thresholds) {
  const { shortLen, longLen, introSentenceSize, mainSentenceSize } = thresholds;
  const vrewMaxChars = thresholds.vrewMaxChars || longLen;
  const disableLongSplit = !!thresholds.disableLongSplit;

  const sid = makeSentenceIder();
  const sentences = items.map((item, i) => {
    const s = new Sentence({ id: sid(item.text), num: i + 1, text: item.text });
    s.isShort = s.charCount < shortLen;
    s.isLong = s.charCount > longLen;
    s.isIntro = !!item.isIntro;
    s.sectionTitle = item.sectionTitle || null;
    s.mode = item.mode;
    s.vrewClips = _buildVrewClips(item.text, s.isLong, vrewMaxChars, disableLongSplit);
    return s;
  });

  const groups = [];
  let gNum = 0;
  let currentGroup = null;
  let currentCount = 0;
  let currentMode = null;          // 'md-intro' | 'md-main' | 'bracket'
  let currentSectionTitle = null;

  const targetModeOf = (s) => {
    if (s.mode === 'bracket') return 'bracket';
    return s.isIntro ? 'md-intro' : 'md-main';
  };

  const startNewGroup = (s) => {
    gNum++;
    currentGroup = new Group({ num: gNum, sentenceIds: [] });
    currentGroup.isIntro = !!s.isIntro;
    currentGroup.isBracket = s.mode === 'bracket';
    currentGroup.title = s.sectionTitle || null;
    groups.push(currentGroup);
    currentCount = 0;
    currentMode = targetModeOf(s);
    currentSectionTitle = s.sectionTitle || null;
  };

  for (const s of sentences) {
    const tm = targetModeOf(s);
    const sectionChanged = (s.mode === 'bracket') && (s.sectionTitle !== currentSectionTitle);

    if (!currentGroup || currentMode !== tm || sectionChanged) {
      startNewGroup(s);
    }

    if (s.mode === 'bracket') {
      // 대괄호: 같은 섹션의 모든 문장을 흡수, 사이즈 무시
      currentGroup.sentenceIds.push(s.id);
      s.groupId = currentGroup.id;
    } else {
      // md: 도입 N문장 / 본론 M문장
      const groupSize = s.isIntro ? (introSentenceSize || 2) : (mainSentenceSize || 3);
      if (s.isShort && currentGroup.sentenceIds.length > 0) {
        currentGroup.sentenceIds.push(s.id);
        s.groupId = currentGroup.id;
      } else {
        if (currentCount >= groupSize) startNewGroup(s);
        currentGroup.sentenceIds.push(s.id);
        s.groupId = currentGroup.id;
        currentCount++;
      }
    }
  }
  finalizeGroupIds(groups, sentences);
  return { sentences, groups };
}

module.exports = { buildGroups, buildGroupsWithSections, buildGroupsWithIntro, buildGroupsHybrid };
