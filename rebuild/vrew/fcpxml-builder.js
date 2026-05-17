'use strict';

/**
 * FCPXML 빌더 — Premiere Pro / DaVinci Resolve / Final Cut Pro 호환 .fcpxml 생성.
 *
 * 매핑 (proj.groups + proj.sentences → FCPXML):
 *   - 각 그룹 = 하나의 video 클립 (이미지 또는 mp4) + 그 안에 자막(title) + 오디오(TTS)
 *   - 그룹의 sentences 안 sub-clips (vrewClips) 마다 자막 한 줄
 *   - 그룹의 sentences 마다 TTS mp3 한 트랙
 *   - AI 고지 — sequence 전체에 걸친 별도 title overlay lane
 *   - 켄번스 — clip 의 adjust-transform 키프레임 (start/end)
 *
 * 출력 호환성 — FCPXML 1.10 (Apple 안정 버전, Premiere Pro 2023+ import 지원).
 * 해상도/프레임레이트 — 1920x1080 / 30fps 고정 (롱폼 16:9 가정, project_video_aspect_policy 참고).
 *
 * 디자인 결정:
 *   - asset 경로는 file:/// 절대경로 (Premiere import 호환성 ↑)
 *   - 시간은 rational (N/30s) — float 부정확성 회피
 *   - 자막은 title 클립 — Premiere 가 title 효과로 인식
 */

const fs = require('fs');
const path = require('path');
const { splitLongSentenceAlgo } = require('../core/long-sentence-splitter/algo-splitter');

const VREW_MAX_CHARS = 20;
const FPS = 30;
const WIDTH = 1920;
const HEIGHT = 1080;

// ─── 헬퍼 ──────────────────────────────────────────────────────────

/** seconds → "N/30s" rational. 30fps 기준 정확 표현. */
function timeRat(seconds) {
  const frames = Math.round(Number(seconds) * FPS);
  return `${frames}/${FPS}s`;
}

/** 0 이상 정수로 truncate */
function _toInt(v, fallback = 0) {
  const n = parseInt(v, 10);
  return Number.isFinite(n) && n >= 0 ? n : fallback;
}

/** Windows 절대경로 → file:/// URI. 공백·한글 자동 인코딩. */
function toFileUri(absPath) {
  if (!absPath) return '';
  const normalized = absPath.replace(/\\/g, '/');
  // 윈도우 드라이브: "C:/foo" → "file:///C:/foo"
  if (/^[A-Za-z]:/.test(normalized)) {
    return 'file:///' + encodeURI(normalized);
  }
  // 그 외 (네트워크/유닉스 경로)
  return 'file://' + encodeURI(normalized);
}

/** XML 엔티티 escape (텍스트 노드 + attribute 값 공통) */
function xmlEscape(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

/** 짧은 unique id (XML id 안전) */
let _idCounter = 0;
function nextId(prefix = 'r') {
  _idCounter++;
  return `${prefix}${_idCounter}`;
}

// ─── 자막 sub-clip 펼치기 ──────────────────────────────────────────
// vrew-builder 와 같은 splitLongSentenceAlgo 사용 — 같은 sub-clip 경계

function expandSentenceToClips(sentence) {
  // 우선 sentence.vrewClips 가 이미 있으면 그대로 사용 (AI 분할 결과 보존)
  let subClips;
  if (sentence.vrewClips && sentence.vrewClips.length > 0) {
    subClips = sentence.vrewClips;
  } else {
    const auto = splitLongSentenceAlgo(sentence.text, VREW_MAX_CHARS);
    subClips = (auto && auto.length > 0) ? auto : [{ text: sentence.text, weight: 1.0 }];
  }
  const totalW = subClips.reduce((s, c) => s + (c.weight || 1), 0) || 1;
  return subClips.map(c => ({
    text: String(c.text || '').trim(),
    ratio: (c.weight || 1) / totalW,
  }));
}

// ─── 켄번스 패턴 ───────────────────────────────────────────────────
// vrew-builder 의 KEN_BURNS_PATTERNS 와 비슷한 5종. 그룹 idx 로 순환.
// FCPXML adjust-transform: start/end 키프레임 (scale + position).

const KEN_BURNS_PATTERNS = [
  // 줌인 (스케일 1.0 → 1.12), 중앙 유지
  { fromScale: 1.0,  toScale: 1.12, fromX:   0, fromY:   0, toX:   0, toY:   0 },
  // 줌아웃 (스케일 1.12 → 1.0)
  { fromScale: 1.12, toScale: 1.0,  fromX:   0, fromY:   0, toX:   0, toY:   0 },
  // 좌→우 팬 (살짝 줌)
  { fromScale: 1.06, toScale: 1.06, fromX: -25, fromY:   0, toX:  25, toY:   0 },
  // 우→좌 팬
  { fromScale: 1.06, toScale: 1.06, fromX:  25, fromY:   0, toX: -25, toY:   0 },
  // 위→아래 팬
  { fromScale: 1.06, toScale: 1.06, fromX:   0, fromY: -25, toX:   0, toY:  25 },
];

/**
 * adjust-transform XML 생성 — clip 시작에 scale/position 키프레임, 끝에 scale/position 키프레임.
 */
function _kenBurnsTransformXml(pattern, clipDurSec) {
  const startT = timeRat(0);
  const endT   = timeRat(clipDurSec);
  return [
    `      <adjust-transform>`,
    `        <param name="position">`,
    `          <keyframe time="${startT}" value="${pattern.fromX} ${pattern.fromY}" interp="linear"/>`,
    `          <keyframe time="${endT}" value="${pattern.toX} ${pattern.toY}" interp="linear"/>`,
    `        </param>`,
    `        <param name="scale">`,
    `          <keyframe time="${startT}" value="${pattern.fromScale} ${pattern.fromScale}" interp="linear"/>`,
    `          <keyframe time="${endT}" value="${pattern.toScale} ${pattern.toScale}" interp="linear"/>`,
    `        </param>`,
    `      </adjust-transform>`,
  ].join('\n');
}

// ─── 빌더 본체 ─────────────────────────────────────────────────────

/**
 * @param {object} project — window._currentProject (sentences/groups 필요)
 * @param {string} outPath — 출력 .fcpxml 파일 경로
 * @param {object} [opts]
 *   opts.aiNotice  { enabled, text, startSeconds, durationSeconds, ... }
 *   opts.kenburns  true|false (default true)
 *   opts.log       (msg) => void
 * @returns {{ path, clipCount, durationSec, missingAssets }}
 */
function buildFcpxml(project, outPath, opts = {}) {
  _idCounter = 0;  // 새 빌드마다 ID 리셋
  const log = opts.log || (() => {});
  const useKenBurns = opts.kenburns !== false;

  // ── 1. 그룹/sentence 데이터 평탄화 ─────────────────────────
  const groups = (project.groups || []).filter(g => !g.skipFromVrew);
  const sentenceMap = {};
  for (const s of (project.sentences || [])) sentenceMap[s.id] = s;

  // 그룹별 클립 메타 모음
  const groupClips = [];
  const missingAssets = [];
  let cumStartSec = 0;

  for (let gi = 0; gi < groups.length; gi++) {
    const g = groups[gi];
    // 그룹의 sentences 시간 합 = 그룹 화면 노출 시간
    const sentenceIds = g.sentenceIds || [];
    const gSentences = sentenceIds.map(id => sentenceMap[id]).filter(Boolean);
    let groupDurSec = 0;
    for (const s of gSentences) {
      groupDurSec += Math.max(0.5, parseFloat(s.ttsDurationSec) || 1.0);
    }
    if (groupDurSec < 0.5) groupDurSec = 0.5;

    const useVideo = g.videoPath && fs.existsSync(g.videoPath);
    const useImage = !useVideo && g.imagePath && fs.existsSync(g.imagePath);
    if (!useVideo && !useImage) {
      missingAssets.push({ groupNum: g.num, groupId: g.id });
    }

    groupClips.push({
      groupIdx: gi,
      group: g,
      sentences: gSentences,
      durSec: groupDurSec,
      startSec: cumStartSec,
      assetPath: useVideo ? g.videoPath : (useImage ? g.imagePath : null),
      isVideo: useVideo,
    });
    cumStartSec += groupDurSec;
  }

  const totalDurSec = cumStartSec;

  // ── 2. resources 모음 — format + 모든 asset ──────────────
  const formatId = nextId('r');
  const resources = [];
  resources.push(
    `    <format id="${formatId}" name="FFVideoFormat1080p${FPS}"`
    + ` frameDuration="1/${FPS}s" width="${WIDTH}" height="${HEIGHT}"`
    + ` colorSpace="1-1-1 (Rec. 709)"/>`
  );

  // 이미지/비디오/오디오 자원 — 같은 경로는 같은 id 재사용
  const assetIdByPath = {};
  function registerAsset(absPath, { hasAudio, hasVideo, durSec, isImage }) {
    if (!absPath || !fs.existsSync(absPath)) return null;
    if (assetIdByPath[absPath]) return assetIdByPath[absPath];
    const aid = nextId('r');
    assetIdByPath[absPath] = aid;
    const name = path.basename(absPath);
    const src = toFileUri(absPath);
    const audioAttr = hasAudio ? ` hasAudio="1" audioSources="1" audioChannels="2" audioRate="48000"` : '';
    const videoAttr = hasVideo ? ` hasVideo="1" videoSources="1"` : '';
    const durAttr = isImage ? ` duration="0s"` : ` duration="${timeRat(durSec || 0.1)}"`;
    resources.push(
      `    <asset id="${aid}" name="${xmlEscape(name)}" src="${src}"`
      + ` start="0s"${durAttr}${videoAttr}${audioAttr} format="${formatId}"/>`
    );
    return aid;
  }

  // 그룹별 메인 미디어 asset 등록
  for (const gc of groupClips) {
    if (!gc.assetPath) continue;
    gc.assetId = registerAsset(gc.assetPath, {
      hasVideo: true,
      hasAudio: gc.isVideo,  // mp4 는 오디오 트랙 있을 수 있지만 우리는 음소거로 사용
      durSec: gc.durSec,
      isImage: !gc.isVideo,
    });
  }

  // TTS 오디오 asset 등록 (sentence 별)
  for (const gc of groupClips) {
    for (const s of gc.sentences) {
      if (s.ttsAudioPath && fs.existsSync(s.ttsAudioPath)) {
        s._assetId = registerAsset(s.ttsAudioPath, {
          hasAudio: true,
          hasVideo: false,
          durSec: parseFloat(s.ttsDurationSec) || 1.0,
          isImage: false,
        });
      }
    }
  }

  // ── 3. spine (메인 타임라인) ─────────────────────────────
  const spine = [];

  for (const gc of groupClips) {
    const dur = timeRat(gc.durSec);
    const offset = timeRat(gc.startSec);

    if (!gc.assetId) {
      // 자산 없는 그룹 — 검은 화면 placeholder. Premiere 가 빈 슬롯도 인식.
      spine.push(`      <gap offset="${offset}" duration="${dur}" name="(missing ${gc.group.num})"/>`);
      continue;
    }

    const clipTag = gc.isVideo ? 'asset-clip' : 'video';
    const startAttr = gc.isVideo ? ' start="0s"' : '';
    const kbXml = useKenBurns
      ? _kenBurnsTransformXml(KEN_BURNS_PATTERNS[gc.groupIdx % KEN_BURNS_PATTERNS.length], gc.durSec)
      : '';
    // 비디오 음소거 (asset-clip 안 audio-role)
    const muteXml = gc.isVideo
      ? `      <adjust-volume amount="-96dB"/>`
      : '';

    const inner = [];
    if (kbXml) inner.push(kbXml);
    if (muteXml) inner.push(muteXml);

    // 자막 + 오디오 안의 lane (음수 lane = 위쪽으로 쌓임, 양수 = 아래로)
    //   lane 1: 자막 (title)
    //   lane -1: TTS 오디오 (audio asset-clip)
    // 자막: sentence 별 sub-clip 펼치기
    let subClipAccumSec = 0;
    for (const s of gc.sentences) {
      const sDur = Math.max(0.5, parseFloat(s.ttsDurationSec) || 1.0);
      const expandedClips = expandSentenceToClips(s);
      let subAcc = 0;
      for (const sc of expandedClips) {
        const subDur = sDur * sc.ratio;
        if (!sc.text || subDur <= 0) {
          subAcc += subDur;
          continue;
        }
        const subOffset = timeRat(subClipAccumSec + subAcc);
        const subDurRat = timeRat(subDur);
        // title 안 text 는 <text><text-style ref="..."/>...</text>. 단순화: 기본 스타일.
        inner.push([
          `      <title lane="1" offset="${subOffset}" duration="${subDurRat}" name="${xmlEscape(sc.text.slice(0, 40))}" role="iTT.iTT-en">`,
          `        <text>`,
          `          <text-style>${xmlEscape(sc.text)}</text-style>`,
          `        </text>`,
          `      </title>`,
        ].join('\n'));
        subAcc += subDur;
      }
      subClipAccumSec += sDur;
    }

    // TTS 오디오 — sentence 별 별도 audio asset-clip 으로
    let ttsAcc = 0;
    for (const s of gc.sentences) {
      const sDur = Math.max(0.5, parseFloat(s.ttsDurationSec) || 1.0);
      if (s._assetId) {
        inner.push([
          `      <asset-clip lane="-1" offset="${timeRat(ttsAcc)}" duration="${timeRat(sDur)}" name="${xmlEscape((s.text || '').slice(0, 30))}" ref="${s._assetId}" audioRole="dialogue" start="0s"/>`,
        ].join('\n'));
      }
      ttsAcc += sDur;
    }

    spine.push([
      `      <${clipTag} offset="${offset}" duration="${dur}" name="${xmlEscape(`Group ${gc.group.num || gc.groupIdx + 1}`)}" ref="${gc.assetId}"${startAttr}>`,
      ...inner,
      `      </${clipTag}>`,
    ].join('\n'));
  }

  // ── 4. AI 고지 — sequence 전체 위에 별도 title (lane 2) ──
  let aiNoticeXml = '';
  if (opts.aiNotice && opts.aiNotice.enabled && (opts.aiNotice.text || '').trim()) {
    const noticeText = String(opts.aiNotice.text).trim();
    const startSec = Math.max(0, parseFloat(opts.aiNotice.startSeconds) || 0);
    const durSec   = Math.max(0, parseFloat(opts.aiNotice.durationSeconds) || 0);
    const realDur  = durSec > 0 ? durSec : Math.max(1, totalDurSec - startSec);
    // 첫 클립 안에 lane 2 title 로 — Premiere 가 connected clip 처럼 인식
    if (spine.length > 0) {
      // spine 의 첫 클립 닫는 태그 직전에 삽입
      aiNoticeXml = [
        `      <title lane="2" offset="${timeRat(startSec)}" duration="${timeRat(realDur)}" name="AI 고지" role="title">`,
        `        <text>`,
        `          <text-style>${xmlEscape(noticeText)}</text-style>`,
        `        </text>`,
        `      </title>`,
      ].join('\n');
      // spine 첫 요소가 클립이면 그 안에 추가
      const firstClipIdx = spine.findIndex(s => /<(asset-clip|video)\b/.test(s));
      if (firstClipIdx >= 0) {
        const closing = /<\/(asset-clip|video)>/;
        spine[firstClipIdx] = spine[firstClipIdx].replace(closing, aiNoticeXml + '\n      </$1>');
      }
    }
  }

  // ── 5. 직렬화 ───────────────────────────────────────────
  const projectName = path.basename(outPath, '.fcpxml');
  const totalDurRat = timeRat(totalDurSec);

  const xml = [
    `<?xml version="1.0" encoding="UTF-8"?>`,
    `<!DOCTYPE fcpxml>`,
    `<fcpxml version="1.10">`,
    `  <resources>`,
    ...resources,
    `  </resources>`,
    `  <library>`,
    `    <event name="PrimingFlow">`,
    `      <project name="${xmlEscape(projectName)}">`,
    `        <sequence format="${formatId}" duration="${totalDurRat}" tcStart="0s" tcFormat="NDF" audioLayout="stereo" audioRate="48k">`,
    `          <spine>`,
    ...spine,
    `          </spine>`,
    `        </sequence>`,
    `      </project>`,
    `    </event>`,
    `  </library>`,
    `</fcpxml>`,
  ].join('\n');

  // ── 6. 파일 저장 ────────────────────────────────────────
  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  const tmp = outPath + '.tmp';
  fs.writeFileSync(tmp, xml, 'utf-8');
  try { fs.renameSync(tmp, outPath); }
  catch (e) {
    fs.copyFileSync(tmp, outPath);
    try { fs.unlinkSync(tmp); } catch {}
  }

  log(`[FCPXML] 저장: ${outPath} — ${groupClips.length}개 clip, ${totalDurSec.toFixed(1)}초`);
  if (missingAssets.length > 0) {
    log(`[FCPXML] 자산 누락 ${missingAssets.length}개 — 해당 그룹은 빈 슬롯(gap)으로 저장됨`);
  }

  return {
    path: outPath,
    clipCount: groupClips.length,
    durationSec: totalDurSec,
    missingAssets,
  };
}

module.exports = { buildFcpxml };
