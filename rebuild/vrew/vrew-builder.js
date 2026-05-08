/**
 * vrew-builder — Project (sentences + groups) → .vrew
 *
 * Vrew 4.0.1 음성 정상 형식 (test.vrew 분석 결과):
 *   - ttsDubbing 트랙 사용 안 함 (이게 음성 무음의 원인이었음)
 *   - ttsClip 트랙이 실제 음성 mp3 의 mediaId 를 직접 가리킴
 *   - 한 sentence 의 N sub-clip = N ttsClip 트랙, 같은 mediaId, sourceIn/sourceOut 으로 시간 슬라이스
 *   - volume: 1 (NOT 0 — 0 은 음소거)
 *   - dummy mp3 / TTS_DUBBING 파일 등록 X
 *
 *   - 1 sub-clip = 1 transcript clip (사용자 요구)
 *   - clip.words = [1 type:0 word + 1 type:2 종료 마커]
 *   - clip.captions = sub-clip 텍스트
 *   - clip.assetIds = [imageAid] (그룹 이미지)
 *   - 그룹 = 1 image 트랙 + 1 image asset (role:'sub'). 그룹 내 모든 clip 이 같은 asset 공유
 */

const fs = require('fs');
const path = require('path');
const os = require('os');
const { splitLongSentenceAlgo } = require('../core/long-sentence-splitter/algo-splitter');

const TEMPLATE_PATH = path.join(__dirname, '..', 'vrew-template.json');
const VREW_MAX_CHARS = 20;

const FIXED_MP4_MEDIA_ID = '10000000-0000-0000-0000';

// AI 고지 자막 (Vrew 시스템 텍스트박스)
const TEXTBOX_MEDIA_ID = 'uc-0010-simple-textbox';
const TEXTBOX_DUMMY_BIN = path.join(__dirname, 'dummy', 'uc-0010-simple-textbox.bin');
const TEXTBOX_DUMMY_META = path.join(__dirname, 'dummy', 'uc-0010-simple-textbox.meta.json');

// 채널 로고 오버레이 프리셋
const LOGO_POSITION_PRESETS = {
  'top-left':     { anchorX: 'left',  anchorY: 'top',    margin: 0.02 },
  'top-right':    { anchorX: 'right', anchorY: 'top',    margin: 0.02 },
  'bottom-left':  { anchorX: 'left',  anchorY: 'bottom', margin: 0.02 },
  'bottom-right': { anchorX: 'right', anchorY: 'bottom', margin: 0.02 },
};
const LOGO_SIZE_PRESETS = {
  small:  { width: 0.10, height: 0.10 },
  medium: { width: 0.15, height: 0.15 },
  large:  { width: 0.20, height: 0.20 },
};

// mp4 헤더(moov/trak/tkhd/mvhd) 직접 파싱 — width/height/duration 추출.
// grok-store 추정값(1280x720) 이 실제 영상(예: 1280x704) 과 어긋나면 Vrew 가
// 메타와 실제 frame 차이만큼 흰 letterbox 띠를 그리므로 정확한 값이 필요.
function readMp4VideoMeta(filePath) {
  let fd;
  try {
    fd = fs.openSync(filePath, 'r');
    const stat = fs.fstatSync(fd);
    const bufSize = Math.min(stat.size, 4 * 1024 * 1024); // 첫 4MB 면 moov 포함 충분
    const buf = Buffer.alloc(bufSize);
    fs.readSync(fd, buf, 0, bufSize, 0);
    const out = { width: 0, height: 0, duration: 0 };
    walkMp4Boxes(buf, 0, buf.length, out);
    return (out.width > 0 && out.height > 0) ? out : null;
  } catch (_) {
    return null;
  } finally {
    if (fd != null) { try { fs.closeSync(fd); } catch (_) {} }
  }
}

function walkMp4Boxes(buf, off, end, out) {
  while (off + 8 <= end) {
    let size = buf.readUInt32BE(off);
    const type = buf.toString('ascii', off + 4, off + 8);
    let headerSize = 8;
    if (size === 1) {
      if (off + 16 > end) break;
      size = Number(buf.readBigUInt64BE(off + 8));
      headerSize = 16;
    } else if (size === 0) {
      size = end - off;
    }
    if (size < headerSize || off + size > end) break;
    const body = off + headerSize;
    const bodyEnd = off + size;

    if (type === 'moov' || type === 'trak' || type === 'mdia' ||
        type === 'minf' || type === 'stbl') {
      walkMp4Boxes(buf, body, bodyEnd, out);
    } else if (type === 'mvhd') {
      const v = buf.readUInt8(body);
      let p = body + 4; // version(1) + flags(3)
      if (v === 0) {
        p += 4 + 4; // creation, modification
        const timescale = buf.readUInt32BE(p); p += 4;
        const duration  = buf.readUInt32BE(p);
        if (timescale > 0) out.duration = duration / timescale;
      } else if (v === 1) {
        p += 8 + 8; // creation, modification (64-bit)
        const timescale = buf.readUInt32BE(p); p += 4;
        const duration  = Number(buf.readBigUInt64BE(p));
        if (timescale > 0) out.duration = duration / timescale;
      }
    } else if (type === 'tkhd') {
      const v = buf.readUInt8(body);
      // version 0: creation(4)+modification(4)+track_id(4)+reserved(4)+duration(4)+reserved2(8) = 28
      // version 1: creation(8)+modification(8)+track_id(4)+reserved(4)+duration(8)+reserved2(8) = 40
      // 그 후 layer(2)+alt_group(2)+volume(2)+reserved(2)+matrix(36) = 44
      // 마지막에 width(4)+height(4) (16.16 fixed point)
      let p = body + 4;
      if (v === 0)      p += 28 + 44;
      else if (v === 1) p += 40 + 44;
      else              { off += size; continue; }
      if (p + 8 > bodyEnd) { off += size; continue; }
      const w = buf.readUInt32BE(p) / 65536;
      const h = buf.readUInt32BE(p + 4) / 65536;
      // 비디오 트랙만 width/height > 0 (오디오 트랙은 0)
      if (w > 0 && h > 0) {
        out.width  = Math.round(w);
        out.height = Math.round(h);
      }
    }
    off += size;
  }
}

const uid = () => 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, c => {
  const r = Math.random() * 16 | 0;
  return (c === 'x' ? r : (r & 0x3 | 0x8)).toString(16);
});
const sid = () => uid().replace(/-/g, '').substring(0, 10);

const CAPTION_ATTRS = {
  font: 'Pretendard-Vrew_700', size: '150', color: '#ffffff',
  'outline-on': 'true', 'outline-color': '#000000', 'outline-width': '6',
};

const DEFAULT_SPEAKER = {
  gender: 'female', age: 'middle', provider: 'vrew', lang: 'ko-KR',
  name: 'butter_f', speakerId: 'characteristic2', badge: 'Recommended',
  tags: ['_characteristic', 'cheesy', 'badgirl'],
  versions: ['v4'], isUnavailable: false,
};

const KEN_BURNS_PATTERNS = [
  { from: { scale: 0.668, centerX: 0.5312, centerY: 0.354 }, to: { scale: 0.98, centerX: 0.51, centerY: 0.51 } },
  { from: { scale: 1.00, centerX: 0.50, centerY: 0.50 }, to: { scale: 0.65, centerX: 0.50, centerY: 0.50 } },
  { from: { scale: 0.54, centerX: 0.51, centerY: 0.37 }, to: { scale: 1.00, centerX: 0.50, centerY: 0.50 } },
  { from: { scale: 1.00, centerX: 0.50, centerY: 0.50 }, to: { scale: 0.55, centerX: 0.50, centerY: 0.44 } },
  { from: { scale: 0.70, centerX: 0.65, centerY: 0.35 }, to: { scale: 0.85, centerX: 0.40, centerY: 0.55 } },
];

function ttsCleanText(text) {
  return String(text)
    .replace(/[–—⸻]/g, ' ')
    .replace(/[\x00-\x19]/g, '')
    .replace(/[ -‒―-⯿]/g, '')
    .replace(/[〃-〿゙-゜]/g, '')
    .replace(/[()*\/+:;<=>[\\\]^_{|}~@`]/g, '')
    .replace(/[《》〈〉「」]/g, '')
    .replace(/^['"]|['"]$/g, '')
    .replace(/\s+/g, ' ').trim();
}

function estimateAudioDuration(filePath) {
  try {
    const stat = fs.statSync(filePath);
    const ext = path.extname(filePath).toLowerCase();
    if (ext === '.wav') return Math.max(0.5, (stat.size - 44) / 48000);
    return Math.max(0.5, stat.size / 6000);
  } catch { return 1.0; }
}

// AI 고지 자막 트랙 추가 (Vrew 4.0.1 web 텍스트박스)
function addAiNoticeTrack(pj, opt, clipDurations, log) {
  const text = String(opt.text || '').trim();
  if (!text) {
    log('[Vrew] AI 고지 자막 텍스트 비어있음 — 트랙 생략');
    return null;
  }

  // startDelay (ms) 계산
  let startDelayMs = 0;
  if (opt.startMode === 'seconds') {
    startDelayMs = Math.max(0, Math.round((parseFloat(opt.startSeconds) || 0) * 1000));
  } else {
    // 'clip' 모드 — 1-based, startClip 의 시작 시점 = clip[0..startClip-2] duration 합
    const n = Math.max(1, parseInt(opt.startClip || 1, 10)) - 1;
    let acc = 0;
    for (let i = 0; i < Math.min(n, clipDurations.length); i++) acc += clipDurations[i];
    startDelayMs = Math.round(acc * 1000);
  }
  const durationSeconds = Math.max(0, parseFloat(opt.durationSeconds) || 0); // 0 = 끝까지

  // zIndex — image 트랙 최상단 위에 한 칸. 사용자가 직접 추가한 .vrew 형식과 일치.
  const imageZs = Object.values(pj.props.tracks)
    .filter(t => t.type === 'image')
    .map(t => Number.isFinite(t.zIndex) ? t.zIndex : 0);
  const webZIndex = (imageZs.length ? Math.max(...imageZs) : 0) + 2;

  const tid = sid();

  // 색상 처리 — 사용자가 .vrew 파일을 분석해 확인한 표준 형식:
  //   fontColor    — 텍스트 색 (default #FFFFFF)
  //   outlineColor — 외곽선 색
  //   outlineNone  — true 면 outline-on:'false' 로 외곽선 비활성
  //   bgColor      — 배경 색 (6자리 hex 그대로 = 100% 불투명)
  //   bgNone       — true 면 배경 투명 (#00000000)
  const fontColor    = String(opt.fontColor    || opt.color || '#FFFFFF');
  const outlineColor = String(opt.outlineColor || '#000000');
  const bgRaw        = String(opt.bgColor      || '#FFFFFF').toLowerCase();
  const bgNone       = !!opt.bgNone;
  const outlineNone  = !!opt.outlineNone;
  const bgValue      = bgNone ? '#00000000' : bgRaw;

  const textAttrs = {
    size: String(opt.fontSize || '75'),
    color: fontColor,
    font: 'Pretendard-Vrew_700',
    'outline-color': outlineColor,
    'outline-on': outlineNone ? 'false' : 'true',
    'outline-width': '6',
  };

  pj.props.tracks[tid] = {
    trackId: tid,
    mediaId: TEXTBOX_MEDIA_ID,
    xPos: 0.02, yPos: 0.047,
    height: 0, width: 0.6,
    rotation: 0, zIndex: webZIndex,
    type: 'web',
    deltas: {
      textarea: {
        ops: [
          { insert: text, attributes: textAttrs },
          { insert: '\n' },
        ],
      },
    },
    loop: true,
    durationSeconds,
    importType: 'copy_and_paste',
    enabledInlineTypes: ['bold','italic','font','size','color','background','outline-color','shadow-color'],
    customAttributes: [
      { attributeName: '--textbox-color', type: 'color-hex', value: bgValue },
      { attributeName: '--textbox-align', type: 'textbox-align', value: 'start' },
    ],
    assetEffectInfo: { type: 'fade-in', duration: opt.fadeMs || 1500, startDelay: startDelayMs },
    stats: { styledInFloatingMenu: true, styledInPanel: false },
    scaleFactor: 1.7777777777777777,
  };

  const aid = uid();
  pj.props.assets[aid] = { trackIds: [tid], role: 'sub' };

  // files[] 에 Html 항목 등록 (이미 있으면 skip)
  if (!pj.files.find(f => f.mediaId === TEXTBOX_MEDIA_ID)) {
    if (fs.existsSync(TEXTBOX_DUMMY_META)) {
      const meta = JSON.parse(fs.readFileSync(TEXTBOX_DUMMY_META, 'utf-8'));
      pj.files.push(meta);
    } else {
      log('[Vrew] dummy/uc-0010-simple-textbox.meta.json 누락 — files[] Html 항목 미등록');
    }
  }

  // 노출 구간에 해당하는 clip 들에만 web asset 추가.
  // Vrew 4.0.1 의 web 트랙 durationSeconds 필드는 영상 끝까지 무한 재생되므로,
  // 노출 종료 컨트롤은 clip.assetIds link 를 노출 구간에 한정하는 방식으로 처리.
  // durationSeconds === 0 → 끝까지 (모든 clip 에 추가).
  const visibleStartMs = startDelayMs;
  const visibleEndMs = durationSeconds > 0
    ? startDelayMs + durationSeconds * 1000
    : Infinity;

  let cumMs = 0;
  let linkedClipCount = 0;
  for (let i = 0; i < pj.transcript.clips.length; i++) {
    const c = pj.transcript.clips[i];
    const clipStartMs = cumMs;
    const clipDurMs = (clipDurations[i] || 0) * 1000;
    const clipEndMs = clipStartMs + clipDurMs;
    // clip 구간이 노출 구간과 한 ms라도 겹치면 link
    const overlaps = (clipEndMs > visibleStartMs) && (clipStartMs < visibleEndMs);
    if (overlaps) {
      if (!Array.isArray(c.assetIds)) c.assetIds = [];
      if (!c.assetIds.includes(aid)) c.assetIds.push(aid);
      linkedClipCount++;
    }
    cumMs = clipEndMs;
  }

  log(`[Vrew] AI 고지 자막 추가: "${text.substring(0, 30)}..." startDelay=${startDelayMs}ms duration=${durationSeconds === 0 ? '끝까지' : durationSeconds + 's'} → ${linkedClipCount}/${pj.transcript.clips.length} clips link, zIndex=${webZIndex}`);
  return { trackId: tid, assetId: aid };
}

// 채널 로고 오버레이 트랙 추가 (image type, 모서리 배치, 모든 clip 에 표시)
function addLogoTrack(pj, opt, mediaZip, zIndexBase, log) {
  if (!opt.path || typeof opt.path !== 'string' || !fs.existsSync(opt.path)) {
    log(`[Vrew] 로고 옵션 켜졌으나 파일 없음 — 트랙 생략 (path: ${opt.path})`);
    return null;
  }

  const sizePreset = LOGO_SIZE_PRESETS[opt.size] || LOGO_SIZE_PRESETS.medium;
  const posPreset = LOGO_POSITION_PRESETS[opt.position] || LOGO_POSITION_PRESETS['top-right'];
  const w = sizePreset.width, h = sizePreset.height, m = posPreset.margin;
  const xPos = (posPreset.anchorX === 'left') ? m : (1 - w - m);
  const yPos = (posPreset.anchorY === 'top')  ? m : (1 - h - m);

  const mid = uid();
  const aid = uid();
  const tid = sid();
  const ext = (path.extname(opt.path).toLowerCase().replace('.jpeg','.jpg').replace('.','')) || 'png';
  const fn = `${mid}.${ext}`;
  const fileSize = fs.statSync(opt.path).size;

  pj.files.push({
    version: 1, mediaId: mid, sourceOrigin: 'USER',
    fileSize, name: fn, type: 'Image',
    isTransparent: ext === 'png', fileLocation: 'IN_MEMORY',
  });

  pj.props.tracks[tid] = {
    trackId: tid, mediaId: mid,
    xPos, yPos, height: h, width: w,
    rotation: 0,
    zIndex: zIndexBase + 1,
    type: 'image',
    originalWidthHeightRatio: 1.0,
    editInfo: {},
    stats: { fillType: 'fit', fillMenu: 'floating', rearrangeCount: 0 },
  };
  pj.props.assets[aid] = { trackIds: [tid], role: 'sub' };
  mediaZip.push({ src: opt.path, name: fn });

  // 모든 clip 의 assetIds 에 logo asset 추가 (영상 전체에 노출)
  for (const c of pj.transcript.clips) {
    if (!Array.isArray(c.assetIds)) c.assetIds = [];
    if (!c.assetIds.includes(aid)) c.assetIds.push(aid);
  }

  log(`[Vrew] 채널 로고 추가: ${path.basename(opt.path)} ${opt.position}/${opt.size}`);
  return { trackId: tid, assetId: aid, mediaId: mid };
}

function validateOutput(pj, sentenceCount, imageGroupCount) {
  const errs = [];
  const warns = [];
  if (!pj.files[0] || pj.files[0].mediaId !== FIXED_MP4_MEDIA_ID) {
    errs.push(`files[0] 의 mediaId 가 ${FIXED_MP4_MEDIA_ID} 가 아님 (template 손상?)`);
  }
  const tts = pj.files.filter(f => f.sourceFileType === 'TTS').length;
  const img = pj.files.filter(f => f.type === 'Image').length;
  if (tts !== sentenceCount) errs.push(`TTS file 수 ${tts} ≠ sentence 수 ${sentenceCount}`);
  // Image 는 그룹 + (선택) 로고 → 부족하면 검은 배경으로 대체됨 (경고만)
  if (img < imageGroupCount) warns.push(`Image file 수 ${img} < 이미지 그룹 수 ${imageGroupCount} (부족분은 검은 배경)`);

  let imgMissingClips = 0;
  for (const c of pj.transcript.clips) {
    if (!c.id) errs.push(`clip 에 id 없음`);
    if (c.captionMode !== 'MANUAL') errs.push(`clip ${c.id} captionMode != MANUAL`);
    if (!Array.isArray(c.assetIds) || c.assetIds.length === 0) {
      imgMissingClips++;
    }
    const w = c.words || [];
    if (w.length !== 2) errs.push(`clip ${c.id} words 길이 ${w.length} != 2 (sub-clip word + 종료 마커)`);
    if (w[0]?.type !== 0) errs.push(`clip ${c.id} words[0].type != 0`);
    if (w[1]?.type !== 2) errs.push(`clip ${c.id} words[1].type != 2 (종료 마커)`);
    if (w[0]?.assetIds?.length !== 1) errs.push(`clip ${c.id} words[0].assetIds 길이 ${w[0]?.assetIds?.length} != 1`);
    if (w[1]?.assetIds?.length !== 0) errs.push(`clip ${c.id} words[1].assetIds 비어야 함`);
  }

  const subClipCount = pj.transcript.clips.length;
  const ttsTrackCount = Object.values(pj.props.tracks).filter(t => t.type === 'ttsClip').length;
  const dubTrackCount = Object.values(pj.props.tracks).filter(t => t.type === 'ttsDubbing').length;
  if (ttsTrackCount !== subClipCount) errs.push(`ttsClip 트랙 ${ttsTrackCount} ≠ sub-clip ${subClipCount}`);
  if (dubTrackCount !== 0) errs.push(`ttsDubbing 트랙 ${dubTrackCount} != 0 (4.0.1 형식에선 사용 안 함)`);

  // role 분포
  const trackTypeOfAsset = (a) => pj.props.tracks[a.trackIds[0]]?.type;
  for (const [aid, a] of Object.entries(pj.props.assets)) {
    const tt = trackTypeOfAsset(a);
    if (tt === 'ttsClip' && a.role !== 'main') errs.push(`asset ${aid} (ttsClip) role != 'main'`);
    if (tt === 'image' && a.role !== 'sub') errs.push(`asset ${aid} (image) role != 'sub'`);
    if (tt === 'web' && a.role !== 'sub') errs.push(`asset ${aid} (web) role != 'sub'`);
  }

  // AI 고지 web 트랙이 있다면 files[] 에 Html 항목 등록 보장
  const webTrackCount = Object.values(pj.props.tracks).filter(t => t.type === 'web').length;
  if (webTrackCount > 0) {
    const hasHtml = pj.files.some(f => f.mediaId === 'uc-0010-simple-textbox' && f.type === 'Html');
    if (!hasHtml) errs.push(`web 트랙 ${webTrackCount}개 있으나 files[] 에 uc-0010-simple-textbox (Html) 없음`);
  }

  if (imgMissingClips > 0) warns.push(`이미지 누락 clip ${imgMissingClips}개 — 해당 sub-clip 은 vrew 에서 검은 배경`);

  return { errs, warns };
}

async function buildVrew({ sentences, groups, vrewPath, opts = {} }) {
  const log = typeof opts.logger === 'function' ? opts.logger : () => {};

  let T;
  try {
    T = JSON.parse(fs.readFileSync(TEMPLATE_PATH, 'utf-8'));
  } catch (e) {
    throw new Error(`vrew-template.json 로드 실패: ${e.message}`);
  }

  const pj = JSON.parse(JSON.stringify(T));
  if (!pj.files[0] || pj.files[0].mediaId !== FIXED_MP4_MEDIA_ID) {
    throw new Error(`template 첫 mp4 항목 (${FIXED_MP4_MEDIA_ID}) 누락 — vrew-template.json 손상`);
  }

  const nowIso = new Date().toISOString();
  pj.projectId = uid();
  pj.comment = `4.0.1\t${nowIso}`;
  pj.statistics.saveInfo.created = { version: '4.0.1', date: nowIso, stage: 'release' };
  pj.statistics.saveInfo.updated = { version: '4.0.1', date: nowIso, stage: 'release' };
  pj.props.tracks = {};
  pj.props.assets = {};
  pj.props.ttsClipInfosMap = {};
  pj.props.originalClips = [];
  pj.props.lastTTSSettings = {
    pitch: 0, speed: 0, volume: 0,
    speaker: { ...DEFAULT_SPEAKER }, version: 'v4',
  };
  pj.transcript.clips = [];
  pj.transcript.sceneNames = {};
  pj.transcript.translateInfo = null;

  const mediaZip = [];
  const unifiedSceneId = sid();

  // ---------- 1. 그룹 미디어 등록 (비디오 우선, 없으면 이미지) ----------
  const groupImageAsset = new Map();
  let groupIdx = 0;
  const missingImg = [];
  for (const g of groups) {
    // (a) 비디오가 있으면 비디오 자산 + video/videoAudio 두 트랙 생성 (음소거)
    if (g.videoPath && fs.existsSync(g.videoPath)) {
      const mid = uid();
      const aid = uid();
      const videoTid = sid();
      const audioTid = sid();
      const fn = `${mid}.mp4`;
      const fileSize = fs.statSync(g.videoPath).size;

      // 비디오 메타데이터 — 실제 mp4 헤더(moov/tkhd/mvhd) 직접 파싱이 1순위.
      // grok-store 추정(예: 1280x720)이 실제(예: 1280x704)와 어긋나면 Vrew 가
      // 차이만큼 흰 letterbox 띠를 그리므로 실제값 사용이 필수.
      let videoWidth = 1280, videoHeight = 720, dur = 6;
      const realMeta = readMp4VideoMeta(g.videoPath);
      if (realMeta) {
        videoWidth  = realMeta.width;
        videoHeight = realMeta.height;
        if (realMeta.duration > 0) dur = realMeta.duration;
        log(`[Vrew] mp4 메타: ${path.basename(g.videoPath)} ${videoWidth}x${videoHeight}, ${dur.toFixed(2)}초`);
      } else {
        try {
          const GrokCfg = require('../tts/grok-store').load();
          const isHd = (GrokCfg.videoResolution === '720p');
          videoWidth = isHd ? 1280 : 854;
          videoHeight = isHd ? 720 : 480;
          dur = parseFloat(String(GrokCfg.videoDuration).replace('s', '')) || 6;
        } catch {}
        log(`[Vrew] mp4 헤더 파싱 실패 — grok-store 추정값 사용: ${videoWidth}x${videoHeight}`);
      }

      // 비디오 자산 (사용자 샘플 vrew 형식 그대로)
      pj.files.push({
        version: 1, mediaId: mid, sourceOrigin: 'USER',
        fileSize, name: fn, type: 'AVMedia',
        videoAudioMetaInfo: {
          duration: dur,
          videoInfo: {
            size: { width: videoWidth, height: videoHeight, rotation: 0 },
            frameRate: 24, codec: 'h264', colorSpace: 'unknown',
          },
          audioInfo: { sampleRate: 48000, codec: 'aac', channelCount: 2 },
          mediaContainer: 'm4a',
        },
        sourceFileType: 'ASSET_VIDEO', fileLocation: 'IN_MEMORY',
      });

      // 비디오 트랙 — 영상.vrew (사용자 의도) 형식과 일치:
      //   - fillType: 'cut' 이 stats 안이 아닌 트랙 직속 (이미지와 다름)
      //   - xPos/yPos/width/height = 0/0/1/1 (Vrew 가 비율에 맞춰 자동 cover)
      //   - 흰 letterbox 바 발생 방지
      pj.props.tracks[videoTid] = {
        trackId: videoTid, mediaId: mid,
        xPos: 0, yPos: 0, height: 1, width: 1,
        rotation: 0, zIndex: groupIdx, type: 'video',
        sourceIn: 0, sourceOut: dur,
        originalWidthHeightRatio: videoWidth / videoHeight,
        isTrimmable: true, hasAlphaChannel: false,
        editInfo: {},
        fillType: 'cut',                 // 트랙 직속 (영상.vrew 형식)
      };
      // 비디오 오디오 트랙 — 영상.vrew 와 일치 (volume:0.5)
      pj.props.tracks[audioTid] = {
        trackId: audioTid, mediaId: mid,
        volume: 0.5, sourceIn: 0, sourceOut: dur,
        loop: true, playbackRate: 1, type: 'videoAudio',
      };
      pj.props.assets[aid] = { trackIds: [videoTid, audioTid], role: 'sub' };
      groupImageAsset.set(g.id, { aid, mid, fn, isVideo: true, videoTid, audioTid });
      mediaZip.push({ src: g.videoPath, name: fn });
      groupIdx++;
      continue;
    }

    // (b) 비디오 없으면 기존 이미지 분기
    if (!g.imagePath || !fs.existsSync(g.imagePath)) {
      missingImg.push(g.num ?? g.id);
      continue;
    }
    const mid = uid();
    const aid = uid();
    const tid = sid();
    const ext = (path.extname(g.imagePath).toLowerCase().replace('.jpeg', '.jpg').replace('.', '')) || 'png';
    const fn = `${mid}.${ext}`;
    const fileSize = fs.statSync(g.imagePath).size;

    pj.files.push({
      version: 1, mediaId: mid, sourceOrigin: 'USER',
      fileSize, name: fn, type: 'Image',
      isTransparent: false, fileLocation: 'IN_MEMORY',
    });

    const kb = KEN_BURNS_PATTERNS[groupIdx % KEN_BURNS_PATTERNS.length];
    pj.props.tracks[tid] = {
      trackId: tid, mediaId: mid,
      xPos: -0.004, yPos: 0, height: 1, width: 1.008,
      rotation: 0, zIndex: groupIdx, type: 'image',
      originalWidthHeightRatio: 1.7778,
      kenburnsAnimationInfo: { type: 'custom', from: { ...kb.from }, to: { ...kb.to } },
      editInfo: {},
      stats: { fillType: 'cut', fillMenu: 'floating', rearrangeCount: 0 },
    };
    pj.props.assets[aid] = { trackIds: [tid], role: 'sub' };
    groupImageAsset.set(g.id, { aid, mid, fn });
    mediaZip.push({ src: g.imagePath, name: fn });
    groupIdx++;
  }

  // ---------- 2. sentence 루프 ----------
  let imageGroupCount = groupImageAsset.size;
  let sentenceCount = 0;
  const missingTts = [];
  const clipDurations = []; // index = transcript clip 순번 (0-based), value = 초

  for (const s of sentences) {
    if (!s.ttsAudioPath || !fs.existsSync(s.ttsAudioPath)) {
      missingTts.push(s.num);
      continue;
    }

    const ttsDur = s.ttsDurationSec || estimateAudioDuration(s.ttsAudioPath);
    const ext = (path.extname(s.ttsAudioPath).toLowerCase().replace('.', '')) || 'mp3';
    const codec = (ext === 'wav') ? 'wav' : 'mp3';

    // (a) TTS 파일 — 실제 음성 mp3 1개 (test.vrew 형식)
    const ttsMid = sid();
    const ttsFn = `${ttsMid}.${ext}`;
    const ttsBytes = fs.statSync(s.ttsAudioPath).size;
    pj.files.push({
      version: 1, mediaId: ttsMid, sourceOrigin: 'VREW_RESOURCE',
      fileSize: ttsBytes, name: ttsFn, type: 'AVMedia',
      videoAudioMetaInfo: {
        duration: ttsDur,
        audioInfo: { sampleRate: 24000, codec, channelCount: 1 },
      },
      sourceFileType: 'TTS', fileLocation: 'IN_MEMORY',
    });
    mediaZip.push({ src: s.ttsAudioPath, name: ttsFn });

    // (b) ttsClipInfosMap entry — key = ttsMid (실제 음성 mediaId)
    const cleanText = ttsCleanText(s.text);
    pj.props.ttsClipInfosMap[ttsMid] = {
      pitch: 0, speed: 0, volume: 0,
      speaker: { ...DEFAULT_SPEAKER }, version: 'v4',
      text: { raw: s.text, processed: cleanText, textAspectLang: 'ko-KR' },
      duration: ttsDur,
    };

    // (c) sub-clip 펼치기 — 1 sub-clip = 1 Vrew clip
    let subClips;
    if (s.vrewClips && s.vrewClips.length > 0) {
      subClips = s.vrewClips;
    } else {
      const auto = splitLongSentenceAlgo(s.text, VREW_MAX_CHARS);
      subClips = (auto.length > 0) ? auto : [{ text: s.text, weight: 1.0 }];
    }
    const totalWeight = subClips.reduce((sum, c) => sum + (c.weight || 1), 0) || 1;

    const groupAsset = groupImageAsset.get(s.groupId);
    const clipAssetIds = groupAsset ? [groupAsset.aid] : [];

    let acc = 0;
    for (let i = 0; i < subClips.length; i++) {
      const vc = subClips[i];
      const w = (vc.weight || 1) / totalWeight;
      const clipDur = ttsDur * w;
      const isLast = (i === subClips.length - 1);
      const sourceIn = acc;
      const sourceOut = isLast ? ttsDur : Math.min(acc + clipDur, ttsDur);
      const realDur = sourceOut - sourceIn;

      // ttsClip 트랙 — 실제 음성 mediaId 의 시간 슬라이스, volume:1
      const ttsTid = sid();
      const ttsAid = uid();
      pj.props.tracks[ttsTid] = {
        trackId: ttsTid, mediaId: ttsMid, volume: 1,
        sourceIn, sourceOut,
        loop: false, fade: { in: false, out: false },
        playbackRate: 1, type: 'ttsClip',
      };
      pj.props.assets[ttsAid] = { trackIds: [ttsTid], role: 'main' };

      // transcript clip — 1 sub-clip = 1 clip
      const wordsArr = [
        {
          id: sid(),
          text: vc.text,
          playbackRate: 1,
          duration: realDur,
          aligned: false,
          type: 0,
          originalDuration: realDur,
          originalStartTime: 0,
          truncatedWords: [],
          assetIds: [ttsAid],
        },
        {
          id: sid(),
          text: '',
          playbackRate: 1,
          duration: 0,
          aligned: false,
          type: 2,
          originalDuration: 0,
          originalStartTime: realDur,
          truncatedWords: [],
          assetIds: [],
        },
      ];

      pj.transcript.clips.push({
        sceneId: unifiedSceneId,
        id: sid(),
        captionMode: 'MANUAL',
        words: wordsArr,
        captions: [
          { text: [{ attributes: CAPTION_ATTRS, insert: vc.text }, { insert: '\n' }] },
          { text: [{ insert: '\n' }] },
        ],
        assetIds: [...clipAssetIds],
        dirty: { blankDeleted: false, caption: false, video: false },
        translationModified: { result: false, source: false },
      });
      clipDurations.push(realDur);

      acc = sourceOut;
    }

    sentenceCount++;
  }

  if (pj.transcript.clips.length === 0) {
    throw new Error('생성할 클립 없음 — TTS 가 변환된 sentence 가 하나도 없음');
  }

  // ---------- 2.4. 비디오 트랙의 sourceOut 을 그룹 sentence 시간 합으로 갱신 ----------
  // 비디오 자체는 6초인데 그룹 sentence 가 더 길면 loop:true 로 늘려 재생.
  for (const g of groups) {
    const ga = groupImageAsset.get(g.id);
    if (!ga || !ga.isVideo) continue;
    let groupDur = 0;
    for (const s of sentences) {
      if (s.groupId === g.id && s.ttsAudioPath && s.ttsDurationSec) {
        groupDur += s.ttsDurationSec;
      }
    }
    if (groupDur > 0) {
      const vTrack = pj.props.tracks[ga.videoTid];
      const aTrack = pj.props.tracks[ga.audioTid];
      if (vTrack) vTrack.sourceOut = groupDur;
      if (aTrack) aTrack.sourceOut = groupDur;
    }
  }

  // ---------- 2.5. AI 고지 자막 (web 트랙) ----------
  if (opts.aiNotice && opts.aiNotice.enabled) {
    try {
      addAiNoticeTrack(pj, opts.aiNotice, clipDurations, log);
    } catch (e) {
      log(`[Vrew] AI 고지 자막 추가 실패: ${e.message}`);
    }
  }

  // ---------- 2.6. 채널 로고 오버레이 (image 트랙) ----------
  if (opts.logo && opts.logo.enabled) {
    try {
      addLogoTrack(pj, opts.logo, mediaZip, groupIdx, log);
    } catch (e) {
      log(`[Vrew] 로고 트랙 추가 실패: ${e.message}`);
    }
  }

  // ---------- 3. self-check ----------
  const { errs, warns } = validateOutput(pj, sentenceCount, imageGroupCount);
  if (warns.length > 0) {
    log(`[Vrew] self-check 경고:\n  - ${warns.join('\n  - ')}`);
  }
  if (errs.length > 0) {
    log(`[Vrew] self-check 실패:\n  - ${errs.join('\n  - ')}`);
    if (!opts.skipSelfCheck) {
      throw new Error(`vrew self-check 실패 (${errs.length}건):\n${errs.join('\n')}`);
    }
  }

  // ---------- 4. ZIP ----------
  const tmpDir = path.join(os.tmpdir(), `vrew_build_${Date.now()}`);
  const tmpMedia = path.join(tmpDir, 'media');
  fs.mkdirSync(tmpMedia, { recursive: true });
  fs.writeFileSync(path.join(tmpDir, 'project.json'), JSON.stringify(pj), 'utf-8');
  for (const m of mediaZip) {
    fs.copyFileSync(m.src, path.join(tmpMedia, m.name));
  }
  // AI 고지 자막 트랙이 추가되었으면 uc-0010-simple-textbox.bin 도 동봉
  // (ZIP 안 파일명은 .bin, files[].name 은 .html — Vrew 매핑 규칙)
  if (opts.aiNotice && opts.aiNotice.enabled && opts.aiNotice.text) {
    if (fs.existsSync(TEXTBOX_DUMMY_BIN)) {
      fs.copyFileSync(TEXTBOX_DUMMY_BIN, path.join(tmpMedia, 'uc-0010-simple-textbox.bin'));
    } else {
      log(`[Vrew] dummy/uc-0010-simple-textbox.bin 누락 — AI 고지 자막이 빈 박스로 표시될 수 있음`);
    }
  }

  const AdmZip = require('adm-zip');
  const zip = new AdmZip();
  zip.addLocalFile(path.join(tmpDir, 'project.json'));
  if (fs.existsSync(tmpMedia)) {
    for (const fn of fs.readdirSync(tmpMedia).sort()) {
      zip.addLocalFile(path.join(tmpMedia, fn), 'media');
    }
  }
  zip.writeZip(vrewPath);

  log(`[Vrew] (4.0.1 test.vrew 형식) ${pj.transcript.clips.length}개 clip · ${imageGroupCount}개 image · ${sentenceCount}개 TTS → ${path.basename(vrewPath)}`);
  if (missingImg.length > 0) log(`[Vrew] 이미지 누락 그룹: ${missingImg.join(', ')}`);
  if (missingTts.length > 0) log(`[Vrew] TTS 누락 sentence: ${missingTts.join(', ')}`);

  if (opts.dumpJson !== false) {
    try {
      const dumpPath = vrewPath + '.debug.json';
      fs.writeFileSync(dumpPath, JSON.stringify(pj, null, 2), 'utf-8');
      log(`[Vrew] 진단 dump: ${path.basename(dumpPath)}`);
    } catch {}
  }

  try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {}

  return {
    vrewPath,
    clipCount: pj.transcript.clips.length,
    imageCount: imageGroupCount,
    sentenceCount,
    missing: missingTts,
    missingImages: missingImg,
  };
}

module.exports = { buildVrew };
