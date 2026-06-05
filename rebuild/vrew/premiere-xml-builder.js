/**
 * premiere-xml-builder — Project (sentences + groups) → Adobe Premiere Pro XML.
 *
 * 출력 형식: Final Cut Pro 7 XML (XMEML v5) — Premiere Pro 2025 호환.
 *   - 비디오 트랙 1개 (그룹별 이미지/영상 순차 배치)
 *   - 오디오 트랙 1개 (sentence 별 TTS mp3 순차 배치)
 *   - 자막은 별도 .srt 파일로 동봉 (Premiere File>Import 로 캡션 트랙 가져오기)
 *
 * (v1.13.62 보강) 프리미어 import 어설픔 4종 해결:
 *   1. 길이를 파일크기로 추측하던 것 → ffmpeg 로 실제 길이 측정 (오디오·자막 드리프트 해결)
 *   2. 이미지가 프레임에 안 맞던 것 → Basic Motion scale-to-fill (해상도 측정 후 꽉 채움)
 *   3. 깨지던 FCP7 Text 제너레이터 자막 트랙 제거 → 정확한 .srt 한 가지로 일원화
 *   4. 밋밋하던 정지 이미지 → Basic Motion scale 키프레임으로 켄번스(슬로우 줌)
 *
 * 입력 인터페이스는 vrew-builder.js 와 동일: { sentences, groups, xmlPath, opts }
 */

const fs = require('fs');
const path = require('path');
const { getMediaInfo } = require('../core/media-utils');

// === 시퀀스 상수 ===
const FRAME_RATE = 30;
const NTSC = 'FALSE';
let VIDEO_WIDTH = 1920;    // buildPremiereXml 진입 시 opts.aspect 로 설정 (9:16 → 1080×1920)
let VIDEO_HEIGHT = 1080;
const AUDIO_SAMPLE_RATE = 48000;   // Premiere 가 24kHz mp3 도 48k 시퀀스에서 잘 받음
const AUDIO_DEPTH = 16;
const KB_ZOOM = 1.20;              // 켄번스 슬로우 줌 비율 (20% — 또렷하게)

// === 헬퍼 ===

// ffmpeg 측정 실패 시에만 쓰는 거친 폴백 (파일 크기 기반). 정상 경로는 getMediaInfo 사용.
function _estimateAudioDurationFallback(filePath) {
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

// 이미지/영상 해상도 → 1920x1080 프레임을 꽉 채우는 Basic Motion scale 퍼센트.
// fill = max(W비, H비) → 짧은 변 기준으로 꽉 채우고 넘치는 부분은 잘림 (16:9 소스면 정확히 맞음).
function _fillScalePct(w, h) {
  if (!w || !h) return 100;
  return Math.max(VIDEO_WIDTH / w, VIDEO_HEIGHT / h) * 100;
}

// Windows 절대경로 → file://localhost URL (segment 별 percent encoding 으로 한글·공백 호환).
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
// sub-clip 의 sourceIn/sourceOut(ms) 이 있으면 그 비율을 timing 으로, 없으면 글자수 비율 균등 분배.
function buildSrtContent(sentences, audioDurations) {
  const out = [];
  let cursor = 0;
  let cueIdx = 1;

  for (let i = 0; i < sentences.length; i++) {
    const s = sentences[i];
    const dur = audioDurations[i] || 1;
    const clips = (s.vrewClips && s.vrewClips.length > 0) ? s.vrewClips : null;

    if (clips && clips.length > 0) {
      const totalChars = clips.reduce((a, c) => a + (c.text ? c.text.length : 0), 0);
      let subCursor = 0;
      for (const sub of clips) {
        const subText = (sub.text || '').trim();
        if (!subText) continue;

        let subDur;
        if (sub.sourceIn != null && sub.sourceOut != null && sub.sourceOut > sub.sourceIn) {
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

  return { content: out.join('\n'), cueCount: cueIdx - 1 };
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

// Basic Motion 필터 — 이미지/영상을 프레임에 꽉 채우고(scale-to-fill), 켄번스(줌) 키프레임 옵션.
//   fromPct === toPct → 정지(단일 value), 다르면 0~durationFrames 사이 두 키프레임으로 슬로우 줌.
// Premiere Pro 2025 가 FCP7 XML 의 'basic' (Basic Motion) scale 파라미터/키프레임을 인식.
function _basicMotionFilter(fromPct, toPct, durationFrames) {
  let scaleBody;
  if (Math.abs(fromPct - toPct) < 0.01) {
    scaleBody = `
            <value>${fromPct.toFixed(2)}</value>`;
  } else {
    scaleBody = `
            <keyframe>
              <when>0</when>
              <value>${fromPct.toFixed(2)}</value>
            </keyframe>
            <keyframe>
              <when>${durationFrames}</when>
              <value>${toPct.toFixed(2)}</value>
            </keyframe>`;
  }
  return `
          <filter>
            <effect>
              <name>Basic Motion</name>
              <effectid>basic</effectid>
              <effectcategory>motion</effectcategory>
              <effecttype>motion</effecttype>
              <mediatype>video</mediatype>
              <parameter authoringApp="PremierePro">
                <parameterid>scale</parameterid>
                <name>Scale</name>
                <valuemin>0</valuemin>
                <valuemax>1000</valuemax>${scaleBody}
              </parameter>
            </effect>
          </filter>`;
}

// inFr/outFr = 소스 미디어 in/out(프레임), startFr/endFr = 타임라인 위치, fileDurFrames = 소스 전체 길이.
// 비디오 루프 시 같은 파일을 0~vidDur 로 여러 번 배치하기 위해 in/out 을 분리해 받음.
function _videoClipitem(id, name, absPath, fileId, inFr, outFr, startFr, endFr, fileDurFrames, motionFilterXml) {
  return `
        <clipitem id="${id}">
          <name>${xmlEscape(name)}</name>
          <enabled>TRUE</enabled>
          <duration>${fileDurFrames}</duration>
          <rate>
            <timebase>${FRAME_RATE}</timebase>
            <ntsc>${NTSC}</ntsc>
          </rate>
          <in>${inFr}</in>
          <out>${outFr}</out>
          <start>${startFr}</start>
          <end>${endFr}</end>${_videoFileElement(absPath, fileId, fileDurFrames)}${motionFilterXml || ''}
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
 * @returns { xmlPath, srtPath, totalSeconds, totalFrames, videoClipCount, audioClipCount, srtCueCount }
 */
async function buildPremiereXml({ sentences, groups, xmlPath, opts = {} }) {
  const log = typeof opts.logger === 'function' ? opts.logger : () => {};

  // 출력 비율 — 9:16(쇼츠) 이면 세로 시퀀스. 헬퍼·시퀀스 포맷이 모듈 변수를 읽으므로 진입 시 설정.
  if (opts.aspect === '9:16') { VIDEO_WIDTH = 1080; VIDEO_HEIGHT = 1920; }
  else { VIDEO_WIDTH = 1920; VIDEO_HEIGHT = 1080; }

  if (!Array.isArray(sentences) || sentences.length === 0) {
    throw new Error('sentences 가 비어있습니다');
  }
  if (!Array.isArray(groups) || groups.length === 0) {
    throw new Error('groups 가 비어있습니다');
  }

  // 1. 각 sentence mp3 의 실제 길이 측정 (ffmpeg, 병렬). 측정 실패 시 크기 추정으로 폴백.
  log(`[PremiereXml] 오디오 길이 측정 중 (${sentences.length}개)...`);
  const audioDurations = await Promise.all(sentences.map(async (s) => {
    if (!s.ttsAudioPath || !fs.existsSync(s.ttsAudioPath)) return 1.0;
    const info = await getMediaInfo(s.ttsAudioPath);
    return (info.durationSec && info.durationSec > 0)
      ? info.durationSec
      : _estimateAudioDurationFallback(s.ttsAudioPath);
  }));
  const totalSec = audioDurations.reduce((a, b) => a + b, 0);
  const totalFrames = secToFrames(totalSec);
  log(`[PremiereXml] 총 길이: ${totalSec.toFixed(2)}초 (${totalFrames} frames @ ${FRAME_RATE}fps)`);

  // 그룹 미디어(이미지/영상) 해상도 미리 측정 (병렬) — scale-to-fill 계산용.
  const mediaDimCache = new Map();
  await Promise.all(groups.map(async (g) => {
    const p = (g.videoPath && fs.existsSync(g.videoPath)) ? g.videoPath
            : (g.imagePath && fs.existsSync(g.imagePath) ? g.imagePath : null);
    if (p && !mediaDimCache.has(p)) {
      const info = await getMediaInfo(p);
      mediaDimCache.set(p, info);
    }
  }));

  // 2. 비디오 트랙 — 그룹 단위 이미지/영상 배치 (+ scale-to-fill, 이미지엔 켄번스 줌)
  // 이미지 없는 그룹은 직전 그룹 이미지 재사용 → V1 트랙 gap 제거.
  const sentIdToIdx = new Map();
  sentences.forEach((s, i) => sentIdToIdx.set(s.id, i));

  const videoClipitems = [];
  let videoCursor = 0;
  let imgIdx = 0;
  let videoSkipCount = 0;
  let videoReuseCount = 0;
  let lastMediaPath = null;
  let kbDirIdx = 0;   // 켄번스 줌인/줌아웃 교대 카운터
  for (const g of groups) {
    const sids = Array.isArray(g.sentenceIds) ? g.sentenceIds : [];
    const groupDurSec = sids.reduce((sum, sid) => {
      const idx = sentIdToIdx.get(sid);
      return sum + (idx != null ? audioDurations[idx] : 0);
    }, 0);
    if (groupDurSec <= 0) continue;

    // 비디오 > 이미지 우선순위 (Vrew 와 동일)
    const ownMediaPath = (g.videoPath && fs.existsSync(g.videoPath))
      ? g.videoPath
      : (g.imagePath && fs.existsSync(g.imagePath) ? g.imagePath : null);
    const isVideo = !!(g.videoPath && fs.existsSync(g.videoPath));

    // 자기 미디어 없으면 직전 이미지 재사용 (gap 채우기)
    const mediaPath = ownMediaPath || lastMediaPath;
    if (!mediaPath) {
      videoSkipCount++;
      videoCursor += groupDurSec;
      continue;
    }
    if (ownMediaPath) lastMediaPath = ownMediaPath;
    else videoReuseCount++;

    const startFr = secToFrames(videoCursor);
    const dim = mediaDimCache.get(mediaPath) || {};
    const fillPct = _fillScalePct(dim.width, dim.height);

    if (isVideo) {
      // 비디오 — 그룹 길이가 소스 영상보다 길면 반복 배치(루프)해 뒷부분 검정 채움 방지.
      const vidDurSec = (dim.durationSec && dim.durationSec > 0) ? dim.durationSec : groupDurSec;
      const vidDurFrames = Math.max(1, secToFrames(vidDurSec));
      const motionXml = _basicMotionFilter(fillPct, fillPct, vidDurFrames);   // 정지 fill (영상 자체 움직임)
      let remaining = secToFrames(groupDurSec);
      let segStart = startFr;
      let rep = 0;
      while (remaining > 0 && rep < 500) {
        const segLen = Math.min(vidDurFrames, remaining);
        const fileId = `file-img-${++imgIdx}`;
        const clipId = `clip-img-${imgIdx}`;
        const name = `그룹 ${g.num} ${path.basename(mediaPath)}${rep > 0 ? ` (반복 ${rep + 1})` : (ownMediaPath ? '' : ' (재사용)')}`;
        videoClipitems.push(_videoClipitem(clipId, name, mediaPath, fileId, 0, segLen, segStart, segStart + segLen, vidDurFrames, motionXml));
        segStart += segLen;
        remaining -= segLen;
        rep++;
      }
    } else {
      // 이미지 — 켄번스 슬로우 줌 (방향 교대)
      const durFrames = secToFrames(groupDurSec);
      const zoomIn = (kbDirIdx % 2 === 0); kbDirIdx++;
      const fromPct = zoomIn ? fillPct : fillPct * KB_ZOOM;
      const toPct   = zoomIn ? fillPct * KB_ZOOM : fillPct;
      const motionXml = _basicMotionFilter(fromPct, toPct, durFrames);
      const fileId = `file-img-${++imgIdx}`;
      const clipId = `clip-img-${imgIdx}`;
      const name = `그룹 ${g.num} ${path.basename(mediaPath)}${ownMediaPath ? '' : ' (재사용)'}`;
      videoClipitems.push(_videoClipitem(clipId, name, mediaPath, fileId, 0, durFrames, startFr, startFr + durFrames, durFrames, motionXml));
    }
    videoCursor += groupDurSec;
  }
  log(`[PremiereXml] 비디오 클립 ${videoClipitems.length}개 (그룹 ${groups.length}, skip ${videoSkipCount}, 재사용 ${videoReuseCount}) — scale-to-fill+켄번스 적용`);

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

  // 4. SRT 자막 (정확한 길이 기반) — 자막은 .srt 한 가지로 일원화.
  //    옛 FCP7 Text 제너레이터 V2 트랙은 Premiere 가 빈 클립/offline 으로 깨뜨려 제거함.
  const { content: srtContent, cueCount: srtCueCount } = buildSrtContent(sentences, audioDurations);

  // 5. XML 조립 (비디오 트랙 1 + 오디오 트랙 1)
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

  // 6. SRT 자막 동봉 (UTF-8 BOM — Premiere 한글 캡션 import 안정화)
  const srtPath = xmlPath.replace(/\.xml$/i, '.srt');
  try {
    fs.writeFileSync(srtPath, '﻿' + srtContent, 'utf8');
    log(`[PremiereXml] SRT 저장: ${srtPath} (자막 ${srtCueCount}큐) — Premiere 에서 File>Import 로 캡션 트랙 추가`);
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
    srtCueCount,
    titleClipCount: srtCueCount,   // 하위호환: UI 가 자막 개수로 표시
  };
}

module.exports = { buildPremiereXml };
