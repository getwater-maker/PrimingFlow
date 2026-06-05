/**
 * video-renderer — Project (sentences + groups) → 유튜브 업로드용 최종 mp4.
 *
 * Vrew/프리미어를 거치지 않고 ffmpeg 로 직접 렌더링:
 *   - 그룹 이미지 → 켄번스(슬로우 줌) 클립 / Grok 비디오 → 16:9 크롭·무음
 *   - sentence 별 dub mp3 를 순서대로 합쳐 오디오 트랙
 *   - vrewClips 타이밍으로 자막 번인 (Pretendard Bold)
 *   - 로고 오버레이 (옵션) → 1920x1080 / 30fps / H.264 + AAC
 *
 * 다단계 패스(세그먼트 생성 → concat → 오디오 → 자막+로고 합성)로 디버깅 용이.
 * 입력 인터페이스는 vrew-builder / premiere-xml-builder 와 동일.
 */

const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');
const { spawn } = require('child_process');
const { getFfmpegPath, getMediaInfo } = require('./media-utils');

const FPS = 30;
const W = 1920;
const H = 1080;
const KB_ZOOM = 0.22;   // 켄번스 줌 폭 (1.0 → 1.22, 또렷한 슬로우 줌)
const KB_UPSCALE = 4;   // 업스케일 배율 — zoompan 정수 반올림 떨림을 서브픽셀로 억제 (클수록 부드럽지만 느림)

// 번들 Pretendard 경로 (asar 패킹 시 unpacked 로 보정). 없으면 Windows 맑은 고딕 폴백.
function _resolveFontPath() {
  let p = path.join(__dirname, '..', 'assets', 'fonts', 'Pretendard-Bold.ttf');
  if (p.includes('app.asar') && !p.includes('app.asar.unpacked')) {
    p = p.replace('app.asar', 'app.asar.unpacked');
  }
  if (fs.existsSync(p)) return p;
  const malgun = 'C:/Windows/Fonts/malgunbd.ttf';
  if (fs.existsSync(malgun)) return malgun;
  return null;
}

function _ffmpeg() {
  const fp = getFfmpegPath();
  if (!fp || !fs.existsSync(fp)) throw new Error('ffmpeg 바이너리를 찾을 수 없습니다.');
  return fp;
}

// ffmpeg 실행 + time= 파싱으로 진행률 보고. cwd 지정 가능 (자막/폰트 상대경로용).
function _runFfmpeg(args, { cwd, totalSec, onProgress, label } = {}) {
  return new Promise((resolve, reject) => {
    let stderr = '';
    const child = spawn(_ffmpeg(), args, { cwd, stdio: ['ignore', 'ignore', 'pipe'] });
    child.stderr.on('data', (chunk) => {
      const txt = chunk.toString();
      stderr += txt;
      if (stderr.length > 32768) stderr = stderr.slice(-32768);
      if (totalSec && onProgress) {
        const m = txt.match(/time=(\d+):(\d+):(\d+(?:\.\d+)?)/);
        if (m) {
          const t = (+m[1]) * 3600 + (+m[2]) * 60 + parseFloat(m[3]);
          const pct = Math.max(0, Math.min(99, (t / totalSec) * 100));
          try { onProgress(pct, label); } catch (_) {}
        }
      }
    });
    child.on('error', (e) => reject(new Error(`ffmpeg 실행 실패(${label || ''}): ${e.message}`)));
    child.on('close', (code) => {
      if (code === 0) return resolve();
      const tail = stderr.split('\n').slice(-8).join('\n');
      reject(new Error(`ffmpeg 종료코드 ${code} (${label || ''})\n${tail}`));
    });
  });
}

// === 자막(ASS) ===

function _assTime(sec) {
  if (!isFinite(sec) || sec < 0) sec = 0;
  const h  = Math.floor(sec / 3600);
  const m  = Math.floor((sec % 3600) / 60);
  const s  = Math.floor(sec % 60);
  const cs = Math.round((sec - Math.floor(sec)) * 100);
  return `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}.${String(cs).padStart(2, '0')}`;
}

function _assEscape(t) {
  return String(t || '').replace(/\\/g, '\\\\').replace(/\{/g, '(').replace(/\}/g, ')').replace(/\r?\n/g, '\\N');
}

// #RRGGBB → ASS &HAABBGGRR (alpha 00 = 불투명). 잘못된 값이면 흰색.
function _hexToAss(hex, alpha) {
  const aa = alpha != null ? alpha : '00';
  const m = String(hex || '').replace('#', '').match(/^([0-9a-fA-F]{6})/);
  if (!m) return `&H${aa}FFFFFF`;
  const r = m[1].slice(0, 2), g = m[1].slice(2, 4), b = m[1].slice(4, 6);
  return (`&H${aa}${b}${g}${r}`).toUpperCase();
}

function _pick(a, b) { return Math.random() < 0.5 ? a : b; }

// 본문 자막(captionStyle) + AI 고지(aiNotice) 를 반영한 ASS 생성.
//   cues       : [{start,end,text}] 본문 자막 (subtitle off 면 빈 배열)
//   opts       : { fontSize, captionStyle, aiNotice }
//   totalSec   : 전체 길이 (AI 고지 '끝까지' 계산용)
//   W, H       : 출력 해상도 (16:9=1920×1080 / 9:16=1080×1920) — 여백·폰트 스케일 기준
function _buildAss(cues, opts, totalSec, W, H) {
  // 폰트 = 가로폭 상대 크기 — 16:9(1920)≈58px, 9:16(1080)≈67px (세로는 폰에서 더 크게)
  const baseFont = opts.fontSize || Math.round(W * (W < H ? 0.062 : 0.0302));
  const cap = opts.captionStyle || {};

  // size: '100'|'125'|'random'
  let capSize = cap.size; if (capSize === 'random') capSize = _pick('100', '125');
  capSize = parseInt(capSize, 10) || 100;
  const capFontPx = Math.max(10, Math.round(baseFont * capSize / 100));
  // align: 'start'(좌)|'center'|'random' → ASS Alignment (1=하단좌, 2=하단중앙)
  let align = cap.align; if (align === 'random') align = _pick('start', 'center');
  const capAlign = (align === 'center') ? 2 : 1;
  // yOffset: 음수 비율 (하단에서 위로) | 'random'
  let yOff = cap.yOffset; if (yOff === 'random') yOff = _pick(-0.125, -0.15);
  yOff = (typeof yOff === 'number') ? yOff : -0.125;
  const capMarginV = Math.max(0, Math.round(Math.abs(yOff) * H));
  const capWidth = (typeof cap.width === 'number' && cap.width > 0) ? cap.width : 0.96;
  const capSide = Math.max(0, Math.round((1 - capWidth) / 2 * W));
  const capFont = _hexToAss(cap.fontColor || '#FFFFFF');
  const capOutline = _hexToAss(cap.outlineColor || '#000000');
  const capBold = cap.bold ? -1 : 0;
  const capItalic = cap.italic ? -1 : 0;

  const styles = [
    `Style: Default,Pretendard,${capFontPx},${capFont},&H000000FF,${capOutline},&H64000000,${capBold},${capItalic},0,0,100,100,0,0,1,3.5,1,${capAlign},${capSide},${capSide},${capMarginV},1`,
  ];

  // AI 고지 문구 — 좌상단(Alignment 7), 자체 색상/배경/외곽선/시작·지속
  const an = opts.aiNotice;
  const events = cues.map(c =>
    `Dialogue: 0,${_assTime(c.start)},${_assTime(c.end)},Default,,0,0,0,,${_assEscape(c.text)}`
  );
  if (an && an.enabled && an.text) {
    const nSize = Math.max(10, Math.round(baseFont * 75 / 100));   // 고지는 75 기준
    const nFont = _hexToAss(an.fontColor || '#FFFFFF');
    const nOutline = an.outlineNone ? '&H00000000' : _hexToAss(an.outlineColor || '#000000');
    const nBack = an.bgNone ? '&H00000000' : _hexToAss(an.bgColor || '#FFFFFF');
    const nBorderStyle = an.bgNone ? 1 : 3;   // 3 = 불투명 배경 박스
    const nOutW = an.outlineNone ? 0 : 3;
    const nBold = an.bold ? -1 : 0;
    const nItalic = an.italic ? -1 : 0;
    const nMarginL = Math.round(0.02 * W);
    const nMarginV = Math.round(0.047 * H);
    styles.push(`Style: Notice,Pretendard,${nSize},${nFont},&H000000FF,${nOutline},${nBack},${nBold},${nItalic},0,0,100,100,0,0,${nBorderStyle},${nOutW},0,7,${nMarginL},${nMarginL},${nMarginV},1`);

    // 시작 시각
    let startSec = 0;
    if (an.startMode === 'seconds') {
      startSec = Math.max(0, parseFloat(an.startSeconds) || 0);
    } else {
      const n = Math.max(1, parseInt(an.startClip || 1, 10)) - 1;
      startSec = (cues[n] && cues[n].start) ? cues[n].start : 0;
    }
    const dur = Math.max(0, parseFloat(an.durationSeconds) || 0);
    const endSec = dur > 0 ? Math.min(totalSec, startSec + dur) : totalSec;
    if (endSec > startSec) {
      const fade = `{\\fad(1200,0)}`;   // vrew 페이드인 흉내
      events.push(`Dialogue: 1,${_assTime(startSec)},${_assTime(endSec)},Notice,,0,0,0,,${fade}${_assEscape(an.text)}`);
    }
  }

  const head = `[Script Info]
ScriptType: v4.00+
PlayResX: ${W}
PlayResY: ${H}
WrapStyle: 2
ScaledBorderAndShadow: yes

[V4+ Styles]
Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding
${styles.join('\n')}

[Events]
Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text
`;
  return head + events.join('\n') + '\n';
}

// === 메인 렌더러 ===

/**
 * @param {object} args
 *   sentences  - Sentence[] ({ id, num, text, ttsAudioPath, vrewClips? })
 *   groups     - Group[]    ({ num, sentenceIds, imagePath, videoPath? })
 *   outPath    - 출력 .mp4 절대경로
 *   opts.logger      - (msg) => void
 *   opts.onProgress  - (pct, label) => void   (0~100)
 *   opts.logoPath    - 우상단 로고 png (옵션)
 *   opts.subtitle    - 자막 번인 여부 (기본 true)
 *   opts.fontSize    - 자막 크기 (기본 54)
 *   opts.crf         - 화질 (기본 20, 낮을수록 고화질)
 * @returns { outPath, totalSeconds, segmentCount }
 */
async function buildVideoMp4({ sentences, groups, outPath, opts = {} }) {
  const log = typeof opts.logger === 'function' ? opts.logger : () => {};
  const onProgress = typeof opts.onProgress === 'function' ? opts.onProgress : () => {};
  const subtitleOn = opts.subtitle !== false;
  const fontSize = opts.fontSize || 58;
  const crf = opts.crf || 20;
  const noticeOn = !!(opts.aiNotice && opts.aiNotice.enabled && opts.aiNotice.text);
  const needAss = subtitleOn || noticeOn;   // 본문자막 OR AI고지 → ASS 번인 패스 필요
  // 출력 비율 — 모듈 상수(W/H=1920×1080)를 함수 내 지역 변수로 덮어써 9:16(1080×1920) 지원
  const aspect = opts.aspect === '9:16' ? '9:16' : '16:9';
  const W = aspect === '9:16' ? 1080 : 1920;
  const H = aspect === '9:16' ? 1920 : 1080;

  if (!Array.isArray(sentences) || !sentences.length) throw new Error('sentences 가 비어있습니다');
  if (!Array.isArray(groups) || !groups.length) throw new Error('groups 가 비어있습니다');

  const fontPath = _resolveFontPath();
  if (needAss && !fontPath) throw new Error('자막 폰트(Pretendard/맑은고딕)를 찾을 수 없습니다.');

  // 작업 디렉토리 (자막/폰트 상대경로용)
  const workDir = path.join(os.tmpdir(), 'pf-render-' + Date.now() + '-' + crypto.randomBytes(3).toString('hex'));
  fs.mkdirSync(workDir, { recursive: true });
  const fontsDir = path.join(workDir, 'fonts');
  fs.mkdirSync(fontsDir, { recursive: true });
  if (fontPath) fs.copyFileSync(fontPath, path.join(fontsDir, 'Pretendard-Bold.ttf'));

  const cleanup = () => { try { fs.rmSync(workDir, { recursive: true, force: true }); } catch (_) {} };

  try {
    // 1. sentence 별 오디오 길이 측정 (병렬)
    log('[Render] 오디오 길이 측정 중...');
    const sentIdToIdx = new Map();
    sentences.forEach((s, i) => sentIdToIdx.set(s.id, i));
    const durations = await Promise.all(sentences.map(async (s) => {
      if (!s.ttsAudioPath || !fs.existsSync(s.ttsAudioPath)) return 0;
      const info = await getMediaInfo(s.ttsAudioPath);
      return (info.durationSec && info.durationSec > 0) ? info.durationSec : 0;
    }));

    // 2. 그룹 순서대로 타임라인 구성 — 비디오 세그먼트와 오디오·자막을 동일 순서로 정렬
    const timeline = [];   // { mediaPath, isVideo, durSec, audios:[{path,dur}], cues:[{start,end,text}] }
    let lastMedia = null, lastIsVideo = false;
    let cursor = 0;
    const audioListPaths = [];
    const cues = [];

    for (const g of groups) {
      const sids = Array.isArray(g.sentenceIds) ? g.sentenceIds : [];
      const grpAudios = [];
      let grpDur = 0;
      for (const sid of sids) {
        const idx = sentIdToIdx.get(sid);
        if (idx == null) continue;
        const s = sentences[idx];
        const dur = durations[idx];
        if (!s.ttsAudioPath || !fs.existsSync(s.ttsAudioPath) || dur <= 0) continue;
        grpAudios.push({ path: s.ttsAudioPath, dur });
        grpDur += dur;

        // 자막 큐 (vrewClips sourceIn/sourceOut 우선, 없으면 글자수 비율)
        const clips = (s.vrewClips && s.vrewClips.length > 0) ? s.vrewClips : null;
        if (clips) {
          const totalChars = clips.reduce((a, c) => a + (c.text ? c.text.length : 0), 0);
          let sub = 0;
          for (const c of clips) {
            const txt = (c.text || '').trim();
            if (!txt) continue;
            let d;
            if (c.sourceIn != null && c.sourceOut != null && c.sourceOut > c.sourceIn) d = (c.sourceOut - c.sourceIn) / 1000;
            else if (totalChars > 0) d = (dur * txt.length) / totalChars;
            else d = dur / clips.length;
            cues.push({ start: cursor + sub, end: cursor + sub + d, text: txt });
            sub += d;
          }
        } else {
          const txt = String(s.text || '').trim();
          if (txt) cues.push({ start: cursor, end: cursor + dur, text: txt });
        }
        cursor += dur;
      }
      if (grpDur <= 0) continue;

      const ownVideo = (g.videoPath && fs.existsSync(g.videoPath)) ? g.videoPath : null;
      const ownImage = (g.imagePath && fs.existsSync(g.imagePath)) ? g.imagePath : null;
      let mediaPath = ownVideo || ownImage;
      let isVideo = !!ownVideo;
      if (!mediaPath) { mediaPath = lastMedia; isVideo = lastIsVideo; }   // gap → 직전 미디어 재사용
      if (!mediaPath) {
        // 첫 그룹부터 미디어 없음 — 검정 배경으로 채움
        mediaPath = null; isVideo = false;
      } else {
        lastMedia = mediaPath; lastIsVideo = isVideo;
      }

      grpAudios.forEach(a => audioListPaths.push(a.path));
      timeline.push({ mediaPath, isVideo, durSec: grpDur });
    }

    if (!timeline.length) throw new Error('렌더할 그룹이 없습니다 (TTS 변환된 문장이 없는 듯)');
    const totalSec = timeline.reduce((a, t) => a + t.durSec, 0);
    log(`[Render] 세그먼트 ${timeline.length}개, 총 ${totalSec.toFixed(1)}초`);

    // 3. 세그먼트별 비디오 생성 (켄번스 / 비디오 크롭 / 검정 배경)
    const concatLines = [];
    let kbDir = 0;
    for (let i = 0; i < timeline.length; i++) {
      const t = timeline[i];
      const segPath = path.join(workDir, `seg_${String(i).padStart(4, '0')}.mp4`);
      const segName = `seg_${String(i).padStart(4, '0')}.mp4`;
      const frames = Math.max(1, Math.round(t.durSec * FPS));
      log(`[Render] 세그먼트 ${i + 1}/${timeline.length} 생성 (${t.durSec.toFixed(1)}초)`);
      onProgress((i / timeline.length) * 40, '세그먼트 생성');

      let args;
      if (!t.mediaPath) {
        // 검정 배경
        args = ['-y', '-f', 'lavfi', '-i', `color=c=black:s=${W}x${H}:r=${FPS}`, '-t', t.durSec.toFixed(3),
          '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '18', '-pix_fmt', 'yuv420p', segPath];
      } else if (t.isVideo) {
        // Grok 비디오 — 16:9 커버 크롭 + 무음 + 길이 맞춤(부족하면 루프)
        args = ['-y', '-stream_loop', '-1', '-i', t.mediaPath, '-an', '-t', t.durSec.toFixed(3),
          '-vf', `scale=${W}:${H}:force_original_aspect_ratio=increase,crop=${W}:${H},fps=${FPS},format=yuv420p`,
          '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '18', segPath];
      } else {
        // 이미지 — 켄번스 슬로우 줌 (방향 교대).
        // zoompan 의 정수 픽셀 반올림이 떨림(jitter)의 원인 → KB_UPSCALE 배 업스케일해
        // 출력 기준 서브픽셀(≈0.1px)로 만들어 부드럽게. 줌은 출력프레임 on 기반 선형(드리프트 없음).
        const UP = KB_UPSCALE;
        const zoomIn = (kbDir % 2 === 0); kbDir++;
        const z = zoomIn
          ? `1+${KB_ZOOM}*on/${frames}`
          : `1+${KB_ZOOM}-${KB_ZOOM}*on/${frames}`;
        const vf = `scale=${W * UP}:${H * UP}:force_original_aspect_ratio=increase,crop=${W * UP}:${H * UP},` +
          `zoompan=z='${z}':x='iw/2-(iw/zoom/2)':y='ih/2-(ih/zoom/2)':d=${frames}:s=${W}x${H}:fps=${FPS},format=yuv420p`;
        args = ['-y', '-i', t.mediaPath, '-vf', vf, '-frames:v', String(frames),
          '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '18', segPath];
      }
      await _runFfmpeg(args, { label: `seg${i}` });
      concatLines.push(`file '${segName}'`);
    }

    // 4. 세그먼트 concat (재인코딩 없이 copy)
    log('[Render] 세그먼트 이어붙이는 중...');
    onProgress(45, '이어붙이기');
    fs.writeFileSync(path.join(workDir, 'segs.txt'), concatLines.join('\n'), 'utf8');
    await _runFfmpeg(['-y', '-f', 'concat', '-safe', '0', '-i', 'segs.txt', '-c', 'copy', 'silent.mp4'],
      { cwd: workDir, label: 'concat-video' });

    // 5. 오디오 concat → aac
    log('[Render] 오디오 합치는 중...');
    onProgress(55, '오디오 합성');
    const audioLines = audioListPaths.map(p => `file '${p.replace(/\\/g, '/').replace(/'/g, "'\\''")}'`);
    fs.writeFileSync(path.join(workDir, 'auds.txt'), audioLines.join('\n'), 'utf8');
    await _runFfmpeg(['-y', '-f', 'concat', '-safe', '0', '-i', 'auds.txt', '-ar', '48000', '-ac', '2',
      '-c:a', 'aac', '-b:a', '192k', 'audio.m4a'], { cwd: workDir, label: 'concat-audio' });

    // 6. 최종 합성 — 자막 번인 + AI 고지 + 로고 오버레이 + 오디오 mux
    log('[Render] 최종 합성 (자막·로고·오디오)...');
    if (needAss) {
      // 본문자막 off 면 cues 비워서 AI 고지만 표시. W/H 로 세로/가로 여백·폰트 스케일.
      fs.writeFileSync(path.join(workDir, 'subs.ass'), _buildAss(subtitleOn ? cues : [], opts, totalSec, W, H), 'utf8');
    }
    const finalArgs = ['-y', '-i', 'silent.mp4', '-i', 'audio.m4a'];
    const hasLogo = opts.logoPath && fs.existsSync(opts.logoPath);
    if (hasLogo) finalArgs.push('-i', opts.logoPath);

    // 필터 체인 구성
    const vf = [];
    let vlabel = '0:v';
    if (needAss) { vf.push(`[${vlabel}]subtitles=subs.ass:fontsdir=fonts[vs]`); vlabel = 'vs'; }
    if (hasLogo) {
      const logoIdx = 2;
      // 로고 크기 — 가로폭 상대 (16:9≈80px 높이 유지, 9:16 은 폭 기준 ~12%)
      const logoFilter = aspect === '9:16' ? `scale=${Math.round(W * 0.12)}:-1` : 'scale=-1:80';
      vf.push(`[${logoIdx}:v]${logoFilter}[lg]`);
      vf.push(`[${vlabel}][lg]overlay=W-w-40:40[vo]`);
      vlabel = 'vo';
    }
    if (vf.length) {
      finalArgs.push('-filter_complex', vf.join(';'), '-map', `[${vlabel}]`, '-map', '1:a');
    } else {
      finalArgs.push('-map', '0:v', '-map', '1:a');
    }
    finalArgs.push('-c:v', 'libx264', '-preset', 'medium', '-crf', String(crf),
      '-c:a', 'aac', '-b:a', '192k', '-pix_fmt', 'yuv420p', '-shortest', '-movflags', '+faststart', 'out.mp4');
    await _runFfmpeg(finalArgs, { cwd: workDir, totalSec, onProgress: (p) => onProgress(60 + p * 0.39, '최종 합성'), label: 'final' });

    // 7. 출력 이동
    fs.mkdirSync(path.dirname(outPath), { recursive: true });
    fs.copyFileSync(path.join(workDir, 'out.mp4'), outPath);
    onProgress(100, '완료');
    log(`[Render] ✅ 완료 — ${outPath} (${totalSec.toFixed(1)}초)`);

    return { outPath, totalSeconds: totalSec, segmentCount: timeline.length };
  } finally {
    cleanup();
  }
}

module.exports = { buildVideoMp4 };
