// 임시 smoketest — vrew-builder 가 reference 형식과 일치하는지 검증
const path = require('path');
const fs = require('fs');
const { buildVrew } = require('./vrew-builder');

const dummyMp3 = path.join(__dirname, '..', 'dummy-tts.mp3');
const imgBase = 'D:/PrimingFlow/복숭아꽃이 흩날리는 가_2026-05-03T13-46/images';
const imgs = [
  path.join(imgBase, '그룹 01_복숭아꽃이 흩날리는 가운데,.jpg'),
  path.join(imgBase, '그룹 02_이 셋이 어떻게 천하를 뒤흔.jpg'),
  path.join(imgBase, '그룹 03_이들을 십상시라 불렀습니다..jpg'),
];

const groups = imgs.map((p, i) => ({
  id: `g_${i + 1}`, num: i + 1, sentenceIds: [],
  imagePath: p,
}));

const sentences = [
  { num: 1, groupId: 'g_1', text: '서기 184년, 한나라는 격동의 시대를 맞이하고 있었습니다.', ttsAudioPath: dummyMp3, ttsDurationSec: 4.8, vrewClips: [] },
  { num: 2, groupId: 'g_1', text: '환관 세력이 권력을 농단하고, 백성들은 도탄에 빠져 있었습니다.', ttsAudioPath: dummyMp3, ttsDurationSec: 5.2, vrewClips: [] },
  { num: 3, groupId: 'g_2', text: '이때 세 명의 영웅이 도원에서 의형제를 맺었습니다.', ttsAudioPath: dummyMp3, ttsDurationSec: 4.0, vrewClips: [] },
  { num: 4, groupId: 'g_2', text: '유비, 관우, 장비 — 이 셋이 어떻게 천하를 뒤흔드는지 보시지요.', ttsAudioPath: dummyMp3, ttsDurationSec: 5.5, vrewClips: [] },
  { num: 5, groupId: 'g_3', text: '환관 십상시, 그들의 권력은 황제마저 능가했습니다.', ttsAudioPath: dummyMp3, ttsDurationSec: 4.3, vrewClips: [] },
  { num: 6, groupId: 'g_3', text: '관직은 돈으로 팔렸고, 법은 무너졌습니다.', ttsAudioPath: dummyMp3, ttsDurationSec: 3.8, vrewClips: [] },
];

const outDir = path.join(__dirname, '..', '..', '_smoketest_out');
fs.mkdirSync(outDir, { recursive: true });
const vrewPath = path.join(outDir, 'smoketest.vrew');

(async () => {
  try {
    const result = await buildVrew({
      sentences, groups, vrewPath,
      opts: { logger: (m) => console.log(m) },
    });
    console.log('\nResult:', result);
    console.log('OK:', vrewPath);
  } catch (e) {
    console.error('FAIL:', e.message);
    process.exit(1);
  }
})();
