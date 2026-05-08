/**
 * Project / Sentence / Group 데이터 모델
 *
 * 사용 흐름:
 *   1. 사용자가 .txt/.md 입력 → splitIntoSentences() → 문장 배열
 *   2. buildGroups(문장 배열, 임계값) → Project 안의 sentences + groups
 *   3. 각 sentence 에 ttsStatus / ttsAudioPath 등이 채워짐 (TTS 변환 후)
 *   4. 각 group 에 imagePath / prompt 등이 채워짐 (이미지 생성 후)
 *   5. .vrew 저장 시 sentences + groups 를 사용
 */

let _seq = 0;
function nextId(prefix) {
  _seq++;
  return `${prefix}_${Date.now().toString(36)}_${_seq}`;
}

/**
 * 유효 글자수 — 한글/영숫자만 카운트.
 * 띄어쓰기·마침표·쉼표·물음표·느낌표·따옴표 등 모두 제외.
 *   "안녕, 반가워!" (8자) → 6 (안/녕/반/가/워)
 *   "Hello world!"   → 10 (Helloworld)
 * 사용처: 짧은/긴 문장 임계값 비교, algo-splitter 의 maxChars 비교
 */
function countMeaningful(text) {
  if (!text) return 0;
  const m = String(text).match(/[가-힣A-Za-z0-9]/g);
  return m ? m.length : 0;
}

class Sentence {
  constructor({ id, num, text }) {
    this.id = id || nextId('s');
    this.num = num;                     // 1부터 시작하는 표시 번호
    this.text = text;
    this.charCount = countMeaningful(text);

    // 임계값 판정 (group-builder 가 채움)
    this.isShort = false;
    this.isLong = false;

    // 그룹 소속
    this.groupId = null;

    // TTS 결과
    this.ttsStatus = 'idle';            // idle | pending | done | fail
    this.ttsAudioPath = null;
    this.ttsDurationSec = null;
    this.ttsPresetId = null;

    // 긴 문장 vrew 분할 결과 (8단계, 정상은 [{text, durationSec}] 1개)
    this.vrewClips = [];
  }
}

class Group {
  constructor({ id, num, sentenceIds }) {
    this.id = id || nextId('g');
    this.num = num;                     // 1부터 시작하는 표시 번호
    this.title = null;                  // 대괄호 섹션 제목 (없으면 null)
    this.sentenceIds = sentenceIds || [];

    // 이미지 (그룹 = 이미지 1장)
    this.imageStatus = 'idle';          // idle | generating | done | fail
    this.imagePath = null;
    this.promptKo = null;
    this.promptEn = null;

    // Grok Imagine 비디오 변환 결과 (이미지 → 영상)
    // videoPath 가 있으면 .vrew 가 이미지 대신 비디오 사용 (Ken Burns 대신 진짜 움직임)
    this.videoStatus = 'idle';          // idle | queued | generating | done | fail
    this.videoPath = null;
    this.videoSourceImage = null;       // 비디오의 원본 이미지 경로 (재시도/롤백용)
    this.videoMotionPrompt = null;      // 사용자가 입력한 모션 프롬프트

    // Ken Burns 카메라 효과 (8단계)
    this.kenburns = null;

    // 사용자 선택 (재생성용)
    this.selected = false;
  }
}

class Project {
  constructor({ scriptText, thresholds, sentences, groups }) {
    this.scriptText = scriptText || '';
    this.thresholds = thresholds || { groupSize: 3, shortLen: 10, longLen: 20 };
    this.sentences = sentences || [];
    this.groups = groups || [];

    this.ttsSettings = { defaultPresetId: null };
    this.imgSettings = {};
  }

  get totalSentences() { return this.sentences.length; }
  get totalGroups() { return this.groups.length; }
  get shortCount() { return this.sentences.filter(s => s.isShort).length; }
  get longCount() { return this.sentences.filter(s => s.isLong).length; }

  /** id → Sentence 빠른 검색 */
  getSentenceById(id) {
    return this.sentences.find(s => s.id === id);
  }

  /** id → Group 빠른 검색 */
  getGroupById(id) {
    return this.groups.find(g => g.id === id);
  }

  /** 그룹의 문장들 반환 */
  getSentencesOfGroup(group) {
    return group.sentenceIds.map(id => this.getSentenceById(id)).filter(Boolean);
  }
}

module.exports = { Sentence, Group, Project, countMeaningful };
