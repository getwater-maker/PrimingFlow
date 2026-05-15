'use strict';

/**
 * 프로젝트 저장/불러오기 — _currentProject 를 출력 폴더 안 project.pflow 로 직렬화.
 *
 * 핵심 설계:
 *   - 자산 경로 (ttsAudioPath/imagePath/videoPath/videoSourceImage) 는 outputDir 기준
 *     상대경로로 저장 → 폴더 통째 이동/복사해도 호환.
 *   - 외부 경로(outputDir 밖)는 절대경로 그대로 유지 (안전).
 *   - atomic write: project.pflow.tmp → rename. 백업 1개 (project.pflow.bak).
 *   - 로드 시 자산 파일 존재 검증 — 없으면 status='idle' 로 reset, 누락 통계 반환.
 */

const fs = require('fs');
const path = require('path');

const FILE_NAME = 'project.pflow';
const BAK_NAME = 'project.pflow.bak';
const CURRENT_VERSION = 1;

/** 절대경로 → outputDir 기준 상대경로. outputDir 밖이면 절대경로 그대로. */
function _toRel(absPath, outputDir) {
  if (!absPath || typeof absPath !== 'string') return absPath || null;
  if (!outputDir) return absPath;
  try {
    const norm = path.resolve(absPath);
    const dir = path.resolve(outputDir);
    if (norm === dir) return '';
    if (norm.startsWith(dir + path.sep)) {
      return path.relative(dir, norm).replace(/\\/g, '/');
    }
  } catch {}
  return absPath;
}

/** 상대 또는 절대 → 절대경로. */
function _toAbs(relOrAbs, outputDir) {
  if (!relOrAbs || typeof relOrAbs !== 'string') return relOrAbs || null;
  if (path.isAbsolute(relOrAbs)) return relOrAbs;
  if (!outputDir) return relOrAbs;
  return path.join(outputDir, relOrAbs.replace(/\//g, path.sep));
}

/**
 * @param {object} project — window._currentProject
 * @param {string} [targetDir] — outputDir 강제 지정 (없으면 project.outputDir/imageOutputDir 사용)
 * @returns {{ path:string, size:number, sentencesCount:number, groupsCount:number, savedAt:string }}
 */
function saveProject(project, targetDir) {
  if (!project) throw new Error('project 가 null');
  const outDir = targetDir || project.outputDir || project.imageOutputDir;
  if (!outDir) throw new Error('출력 폴더가 설정되지 않음 — 프리셋의 출력 폴더 먼저 선택');
  if (!fs.existsSync(outDir)) fs.mkdirSync(outDir, { recursive: true });

  // 깊은 복사 + 자산 경로 상대화
  const clone = JSON.parse(JSON.stringify(project));
  for (const s of (clone.sentences || [])) {
    if (s.ttsAudioPath) s.ttsAudioPath = _toRel(s.ttsAudioPath, outDir);
  }
  for (const g of (clone.groups || [])) {
    if (g.imagePath)        g.imagePath        = _toRel(g.imagePath, outDir);
    if (g.videoPath)        g.videoPath        = _toRel(g.videoPath, outDir);
    if (g.videoSourceImage) g.videoSourceImage = _toRel(g.videoSourceImage, outDir);
  }

  const payload = Object.assign({
    version: CURRENT_VERSION,
    savedAt: new Date().toISOString(),
  }, clone);
  // outputDir 자체는 로드 시 파일 위치로 덮어쓰니 굳이 저장 안 해도 되지만 디버깅 편의로 남김
  payload.outputDir = outDir;

  const target = path.join(outDir, FILE_NAME);
  const tmp = target + '.tmp';
  const bak = path.join(outDir, BAK_NAME);

  // 기존 파일 백업 (1개만 유지)
  if (fs.existsSync(target)) {
    try { fs.copyFileSync(target, bak); } catch (e) { /* 무시 */ }
  }

  // atomic write
  fs.writeFileSync(tmp, JSON.stringify(payload, null, 2), 'utf-8');
  try {
    fs.renameSync(tmp, target);
  } catch (e) {
    // 일부 시스템에서 같은 device 가 아닐 때 EXDEV — copy+unlink fallback
    fs.copyFileSync(tmp, target);
    try { fs.unlinkSync(tmp); } catch {}
  }

  const stat = fs.statSync(target);
  return {
    path: target,
    size: stat.size,
    sentencesCount: (clone.sentences || []).length,
    groupsCount: (clone.groups || []).length,
    savedAt: payload.savedAt,
  };
}

/**
 * @param {string} filePath — project.pflow 절대경로
 * @returns {{
 *   project: object,
 *   stats: { ttsMissing:number, imageMissing:number, videoMissing:number, total: {tts:number, image:number, video:number} }
 * }}
 */
function loadProject(filePath) {
  if (!fs.existsSync(filePath)) throw new Error('파일이 존재하지 않음: ' + filePath);
  const raw = fs.readFileSync(filePath, 'utf-8');
  let data;
  try { data = JSON.parse(raw); }
  catch (e) { throw new Error('프로젝트 파일 파싱 실패: ' + e.message); }
  if (!data || typeof data !== 'object') throw new Error('잘못된 프로젝트 파일 형식');

  data = _migrateIfNeeded(data);
  const outDir = path.dirname(filePath);

  const stats = {
    ttsMissing: 0, imageMissing: 0, videoMissing: 0,
    total: { tts: 0, image: 0, video: 0 },
  };

  // 자산 절대화 + 존재 검증
  for (const s of (data.sentences || [])) {
    if (s.ttsAudioPath) {
      stats.total.tts++;
      const abs = _toAbs(s.ttsAudioPath, outDir);
      if (abs && fs.existsSync(abs)) {
        s.ttsAudioPath = abs;
      } else {
        s.ttsAudioPath = null;
        s.ttsStatus = 'idle';
        s.ttsDurationSec = null;
        stats.ttsMissing++;
      }
    }
  }
  for (const g of (data.groups || [])) {
    if (g.imagePath) {
      stats.total.image++;
      const abs = _toAbs(g.imagePath, outDir);
      if (abs && fs.existsSync(abs)) g.imagePath = abs;
      else {
        g.imagePath = null;
        g.imageStatus = 'idle';
        stats.imageMissing++;
      }
    }
    if (g.videoPath) {
      stats.total.video++;
      const abs = _toAbs(g.videoPath, outDir);
      if (abs && fs.existsSync(abs)) g.videoPath = abs;
      else {
        g.videoPath = null;
        g.videoStatus = 'idle';
        stats.videoMissing++;
      }
    }
    if (g.videoSourceImage) {
      const abs = _toAbs(g.videoSourceImage, outDir);
      g.videoSourceImage = (abs && fs.existsSync(abs)) ? abs : null;
    }
  }

  // outputDir 은 파일 위치 기준으로 항상 덮어씀 (다른 PC/위치로 이동 호환)
  data.outputDir = outDir;
  // imageOutputDir 검증/추정
  if (!data.imageOutputDir || !fs.existsSync(data.imageOutputDir)) {
    const guess = path.join(outDir, 'images');
    if (fs.existsSync(guess)) data.imageOutputDir = guess;
  }

  return { project: data, stats };
}

function _migrateIfNeeded(data) {
  // version 누락 시 1 로 가정
  if (!data.version) data.version = CURRENT_VERSION;
  // 향후 버전 변경 시 분기 추가
  return data;
}

/** 디렉토리 안에 project.pflow 가 있으면 그 경로 반환, 없으면 null. */
function findProjectFile(dir) {
  if (!dir) return null;
  const f = path.join(dir, FILE_NAME);
  return fs.existsSync(f) ? f : null;
}

module.exports = {
  saveProject,
  loadProject,
  findProjectFile,
  FILE_NAME,
  CURRENT_VERSION,
};
