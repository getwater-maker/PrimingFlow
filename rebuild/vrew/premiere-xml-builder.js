/**
 * premiere-xml-builder — Project (sentences + groups) → Adobe Premiere Pro XML.
 *
 * 출력 형식: Final Cut Pro 7 XML (XMEML v5) — Premiere Pro 2025 호환.
 *   - 비디오 트랙 1개 (그룹별 이미지/영상 순차 배치)
 *   - 오디오 트랙 1개 (sentence 별 TTS mp3 순차 배치)
 *   - 자막은 별도 .srt 파일로 동봉 (Premiere 가 캡션 트랙으로 import)
 *
 * 입력 인터페이스는 vrew-builder.js 와 동일:
 *   { sentences, groups, xmlPath, opts }
 *
 * vrew-builder 와 동일한 estimateAudioDuration() 사용 — Vrew/Premiere 동일 timing.
 */

const fs = require('fs');
const path = require('path');

// === 시퀀스 상수 ===
const FRAME_RATE = 30;
const NTSC = 'FALSE';
const VIDEO_WIDTH = 1920;
const VIDEO_HEIGHT = 1080;
const AUDIO_SAMPLE_RATE = 48000;   // Premiere 가 24kHz mp3 도 48k 시퀀스에서 잘 받음
const AUDIO_DEPTH = 16;

// === 헬퍼 ===

// mp3/wav 의 duration 을 외부 도구 없이 추정 (vrew-builder.js 와 동일 로직).
//   - wav: 헤더 44바이트 제외, 24kHz 16bit mono 가정 (48000 bytes/sec)
//   - mp3: 거친 추정 (192kbps 가정, 헤더/패딩 보정 포함하여 6000)
function estimateAudioDuration(filePath) {
  try {
    const stat = fs.statSync(filePath);
    const ext = path.extname(filePath).toLowerCase();
    if (ext === '.wav') return Math.max(0.5, (stat.size - 44) / 48000);
    return Math.max(0.5, stat.size / 6000);
  } catch { return 1.0; }
}

// 초 → 프레임 (반올림, 최소 1)
function secToFrames(sec) {
  return Math.max(1, Math.round(sec * FRAME_RATE));
}

// Windows 절대경로 → file://localhost URL.
//   "G:\내 드라이브\비디오\foo.png" → "file://localhost/G:/%EB%82%B4%20.../foo.png"
// 각 path segment 를 percent encoding 해서 한글·공백·특수문자 모두 호환.
function pathToFileUrl(absPath) {
  if (!absPath) return '';
  const norm = String(absPath).replace(/\\/g, '/');
  const segments = norm.split('/').map(seg => encodeURIComponent(seg));
  return 'file://localhost/' + segments.join('/');
}

// XML 텍스트/속성 이스케이프
function xmlEscape(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

// === SRT (자막 별도 파일) ===

function _formatSrtTime(sec) {
  if (!isFinite(sec) || sec < 0) sec = 0;
  const h  = Math.floor(sec / 3600);
  const m  = Math.floor((sec % 3600) / 60);
  const s  = Math.floor(sec % 60);
  const ms = Math.round((sec - Math.floor(sec)) * 1000);
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')},${String(ms).padStart(3, '0')}`;
}

// vrewClips 가 있으면 그 sub-clip 단위로 자막 분할, 없으면 sentence 전체 한 큐.
// sub-clip 의 sourceIn/sourceOut 이 있으면 그 비율을 timing 으로 사용, 없으면 글자수 비율 균등 분배.
function buildSrtContent(sentences, audioDurations) {
  const out = [];
  let cursor = 0;
  let cueIdx = 1;

  for (let i = 0; i < sentences.length; i++) {
    const s = sentences[i];
    const dur = audioDurations[i] || 1;
    const clips = (s.vrewClips && s.vrewClips.length > 0) ? s.vrewClips : null;

    if (clips && clips.length > 0) {
      // sub-clip 의 sourceIn/sourceOut 이 ms 단위로 정의돼 있으면 그것 사용,
      // 없으면 글자수 비율로 균등 분배
      const totalChars = clips.reduce((a, c) => a + (c.text ? c.text.length : 0), 0);
      let subCursor = 0;
      for (const sub of clips) {
        const subText = (sub.text || '').trim();
        if (!subText) continue;

        let subDur;
        if (sub.sourceIn != null && sub.sourceOut != null && sub.sourceOut > sub.sourceIn) {
          // sourceIn/sourceOut 은 ms 단위 (Vrew 표준)
          subDur = (sub.sourceOut - sub.sourceIn) / 1000;
        } else if (totalChars > 0) {
          subDur = (dur * subText.length) / totalChars;
        } else {
          subDur = dur / clips.length;
        }

        const start = cursor + subCursor;
        const end = start + subDur;
        out.push(String(cueIdx++));
        out.push(`${_formatSrtTime(start)} --> ${_formatSrtTime(end)}`);
        out.push(subText);
        out.push('');
        subCursor += subDur;
      }
    } else {
      const text = String(s.text || '').trim();
      if (text) {
        out.push(String(cueIdx++));
        out.push(`${_formatSrtTime(cursor)} --> ${_formatSrtTime(cursor + dur)}`);
        out.push(text);
        out.push('');
      }
    }
    cursor += dur;
  }

  return out.join('\n');
}

// === XML 요소 빌더 ===

function _videoFileElement(absPath, fileId, durationFrames) {
  const url = pathToFileUrl(absPath);
  const name = xmlEscape(path.basename(absPath));
  return `
        <file id="${fileId}">
          <name>${name}</name>
          <pathurl>${url}</pathurl>
          <rate>
            <timebase>${FRAME_RATE}</timebase>
            <ntsc>${NTSC}</ntsc>
          </rate>
          <duration>${durationFrames}</duration>
          <media>
            <video>
              <samplecharacteristics>
                <rate>
                  <timebase>${FRAME_RATE}</timebase>
                  <ntsc>${NTSC}</ntsc>
                </rate>
                <width>${VIDEO_WIDTH}</width>
                <height>${VIDEO_HEIGHT}</height>
                <anamorphic>FALSE</anamorphic>
                <pixelaspectratio>square</pixelaspectratio>
                <fielddominance>none</fielddominance>
              </samplecharacteristics>
            </video>
          </media>
        </file>`;
}

function _audioFileElement(absPath, fileId, durationFrames) {
  const url = pathToFileUrl(absPath);
  const name = xmlEscape(path.basename(absPath));
  return `
        <file id="${fileId}">
          <name>${name}</name>
          <pathurl>${url}</pathurl>
          <rate>
            <timebase>${FRAME_RATE}</timebase>
            <ntsc>${NTSC}</ntsc>
          </rate>
          <duration>${durationFrames}</duration>
          <media>
            <audio>
              <samplecharacteristics>
                <depth>${AUDIO_DEPTH}</depth>
                <samplerate>${AUDIO_SAMPLE_RATE}</samplerate>
              </samplecharacteristics>
              <channelcount>1</channelcount>
            </audio>
          </media>
        </file>`;
}

function _videoClipitem(id, name, absPath, fileId, startFrames, endFrames, durationFrames) {
  return `
        <clipitem id="${id}">
          <name>${xmlEscape(name)}</name>
          <enabled>TRUE</enabled>
          <duration>${durationFrames}</duration>
          <rate>
            <timebase>${FRAME_RATE}</timebase>
            <ntsc>${NTSC}</ntsc>
          </rate>
          <in>0</in>
          <out>${durationFrames}</out>
          <start>${startFrames}</start>
          <end>${endFrames}</end>${_videoFileElement(absPath, fileId, durationFrames)}
        </clipitem>`;
}

function _audioClipitem(id, name, absPath, fileId, startFrames, endFrames, durationFrames) {
  return `
        <clipitem id="${id}">
          <name>${xmlEscape(name)}</name>
          <enabled>TRUE</enabled>
          <duration>${durationFrames}</duration>
          <rate>
            <timebase>${FRAME_RATE}</timebase>
            <ntsc>${NTSC}</ntsc>
          </rate>
          <in>0</in>
          <out>${durationFrames}</out>
          <start>${startFrames}</start>
          <end>${endFrames}</end>${_audioFileElement(absPath, fileId, durationFrames)}
          <sourcetrack>
            <mediatype>audio</mediatype>
            <trackindex>1</trackindex>
          </sourcetrack>
        </clipitem>`;
}

// === 메인 빌더 ===

/**
 * Project → Premiere XML + 자막 SRT.
 * @param {object} args
 *   sentences  - Sentence[]  (각 sentence: { id, num, text, ttsAudioPath, vrewClips? })
 *   groups     - Group[]     (각 group:    { num, sentenceIds, imagePath, videoPath? })
 *   xmlPath    - 출력 .xml 절대경로
 *   opts.logger        - 로그 함수
 *   opts.sequenceName  - 시퀀스 이름 (default: 'PrimingFlow Sequence')
 * @returns { xmlPath, srtPath, totalSeconds, totalFrames, videoClipCount, audioClipCount }
 */
async function buildPremiereXml({ sentences, groups, xmlPath, opts = {} }) {
  const log = typeof opts.logger === 'function' ? opts.logger : () => {};

  if (!Array.isArray(sentences) || sentences.length === 0) {
    throw new Error('sentences 가 비어있습니다');
  }
  if (!Array.isArray(groups) || groups.length === 0) {
    throw new Error('groups 가 비어있습니다');
  }

  // 1. 각 sentence 의 mp3 duration 계산
  const audioDurations = sentences.map(s => {
    if (!s.ttsAudioPath || !fs.existsSync(s.ttsAudioPath)) return 1.0;
    return estimateAudioDuration(s.ttsAudioPath);
  });
  const totalSec = audioDurations.reduce((a, b) => a + b, 0);
  const totalFrames = secToFrames(totalSec);
  log(`[PremiereXml] 총 길이: ${totalSec.toFixed(2)}초 (${totalFrames} frames @ ${FRAME_RATE}fps)`);

  // 2. 비디오 트랙 — 그룹 단위 이미지/영상 배치
  const sentIdToIdx = new Map();
  sentences.forEach((s, i) => sentIdToIdx.set(s.id, i));

  const videoClipitems = [];
  let videoCursor = 0;
  let imgIdx = 0;
  let videoSkipCount = 0;
  for (const g of groups) {
    const sids = Array.isArray(g.sentenceIds) ? g.sentenceIds : [];
    const groupDurSec = sids.reduce((sum, sid) => {
      const idx = sentIdToIdx.get(sid);
      return sum + (idx != null ? audioDurations[idx] : 0);
    }, 0);
    if (groupDurSec <= 0) continue;

    // 비디오 > 이미지 우선순위 (Vrew 와 동일)
    const mediaPath = (g.videoPath && fs.existsSync(g.videoPath))
      ? g.videoPath
      : (g.imagePath && fs.existsSync(g.imagePath) ? g.imagePath : null);

    if (!mediaPath) {
      videoSkipCount++;
      videoCursor += groupDurSec;   // 시간은 흘러감 (오디오와 sync 보장)
      continue;
    }

    const durFrames = secToFrames(groupDurSec);
    const startFr   = secToFrames(videoCursor);
    const endFr     = startFr + durFrames;
    const fileId    = `file-img-${++imgIdx}`;
    const clipId    = `clip-img-${imgIdx}`;
    const name      = `그룹 ${g.num} ${path.basename(mediaPath)}`;
    videoClipitems.push(_videoClipitem(clipId, name, mediaPath, fileId, startFr, endFr, durFrames));
    videoCursor += groupDurSec;
  }
  log(`[PremiereXml] 비디오 클립 ${videoClipitems.length}개 (그룹 ${groups.length}개 중 ${videoSkipCount}개는 이미지/영상 없어 건너뜀)`);

  // 3. 오디오 트랙 — sentence 단위 mp3 배치
  const audioClipitems = [];
  let audioCursor = 0;
  let audIdx = 0;
  let audioSkipCount = 0;
  for (let i = 0; i < sentences.length; i++) {
    const s = sentences[i];
    const dur = audioDurations[i];
    if (!s.ttsAudioPath || !fs.existsSync(s.ttsAudioPath) || dur <= 0) {
      audioSkipCount++;
      audioCursor += dur;
      continue;
    }
    const durFrames = secToFrames(dur);
    const startFr   = secToFrames(audioCursor);
    const endFr     = startFr + durFrames;
    const fileId    = `file-aud-${++audIdx}`;
    const clipId    = `clip-aud-${audIdx}`;
    const name      = `문장 ${s.num || (i + 1)}`;
    audioClipitems.push(_audioClipitem(clipId, name, s.ttsAudioPath, fileId, startFr, endFr, durFrames));
    audioCursor += dur;
  }
  log(`[PremiereXml] 오디오 클립 ${audioClipitems.length}개 (sentence ${sentences.length}개 중 ${audioSkipCount}개는 TTS 없어 건너뜀)`);

  // 4. XML 조립
  const seqName = xmlEscape(opts.sequenceName || 'PrimingFlow Sequence');
  const xml = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE xmeml>
<xmeml version="5">
  <sequence id="seq-1">
    <name>${seqName}</name>
    <duration>${totalFrames}</duration>
    <rate>
      <timebase>${FRAME_RATE}</timebase>
      <ntsc>${NTSC}</ntsc>
    </rate>
    <media>
      <video>
        <format>
          <samplecharacteristics>
            <rate>
              <timebase>${FRAME_RATE}</timebase>
              <ntsc>${NTSC}</ntsc>
            </rate>
            <width>${VIDEO_WIDTH}</width>
            <height>${VIDEO_HEIGHT}</height>
            <anamorphic>FALSE</anamorphic>
            <pixelaspectratio>square</pixelaspectratio>
            <fielddominance>none</fielddominance>
          </samplecharacteristics>
        </format>
        <track>
          <enabled>TRUE</enabled>
          <locked>FALSE</locked>${videoClipitems.join('')}
        </track>
      </video>
      <audio>
        <numOutputChannels>2</numOutputChannels>
        <format>
          <samplecharacteristics>
            <depth>${AUDIO_DEPTH}</depth>
            <samplerate>${AUDIO_SAMPLE_RATE}</samplerate>
          </samplecharacteristics>
        </format>
        <track>
          <enabled>TRUE</enabled>
          <locked>FALSE</locked>${audioClipitems.join('')}
        </track>
      </audio>
    </media>
    <timecode>
      <rate>
        <timebase>${FRAME_RATE}</timebase>
        <ntsc>${NTSC}</ntsc>
      </rate>
      <string>00:00:00:00</string>
      <frame>0</frame>
      <displayformat>NDF</displayformat>
    </timecode>
  </sequence>
</xmeml>
`;

  fs.writeFileSync(xmlPath, xml, 'utf8');
  log(`[PremiereXml] XML 저장: ${xmlPath} (${(xml.length / 1024).toFixed(1)} KB)`);

  // 5. SRT 자막 동봉
  const srtPath = xmlPath.replace(/\.xml$/i, '.srt');
  try {
    const srtContent = buildSrtContent(sentences, audioDurations);
    fs.writeFileSync(srtPath, srtContent, 'utf8');
    log(`[PremiereXml] SRT 저장: ${srtPath}`);
  } catch (e) {
    log(`[PremiereXml] SRT 저장 실패 (XML 은 정상): ${e.message}`);
  }

  return {
    xmlPath,
    srtPath,
    totalSeconds: totalSec,
    totalFrames,
    videoClipCount: videoClipitems.length,
    audioClipCount: audioClipitems.length,
  };
}

module.exports = { buildPremiereXml };
