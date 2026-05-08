/**
 * 참조음성 폴더 스캐너
 *
 * 사용 흐름:
 *   1. 사용자가 참조음성 폴더 하나 지정 (예: D:/refvoices/다산의뜸)
 *   2. 폴더 안에 WAV + 같은 이름 TXT 묶음 배치
 *      - 01_고전책장.wav  +  01_고전책장.txt
 *      - 02_다산의뜸.wav  +  02_다산의뜸.txt
 *   3. scanFolder() 가 WAV 목록 반환 + TXT 자동 매칭
 *   4. 사용자는 WAV 파일 선택만 하면 됨 — 참조 텍스트는 TXT 에서 자동 로드
 *
 * 결과: [{ name, fileName, wavPath, txtPath, refText }]
 */

const fs = require('fs');
const path = require('path');

const AUDIO_EXT = /\.(wav|mp3|m4a|flac)$/i;

function scanFolder(folder) {
  if (!folder || !fs.existsSync(folder)) return [];
  let entries;
  try {
    entries = fs.readdirSync(folder);
  } catch (e) {
    console.error('[ref-audio-scanner] 폴더 읽기 실패:', e.message);
    return [];
  }

  const items = [];
  const audioFiles = entries.filter(f => AUDIO_EXT.test(f)).sort();

  for (const audio of audioFiles) {
    const ext = path.extname(audio);
    const baseName = path.basename(audio, ext);
    const wavPath = path.join(folder, audio);

    // 같은 이름의 TXT 자동 매칭
    let refText = '';
    let txtPath = null;
    const txtCandidates = [`${baseName}.txt`, `${baseName}.TXT`];
    for (const txt of txtCandidates) {
      const fullTxt = path.join(folder, txt);
      if (fs.existsSync(fullTxt)) {
        try {
          refText = fs.readFileSync(fullTxt, 'utf-8').trim();
          txtPath = fullTxt;
          break;
        } catch {}
      }
    }

    items.push({
      name: baseName,
      fileName: audio,
      wavPath,
      txtPath,
      refText,
    });
  }

  return items;
}

module.exports = { scanFolder };
