'use strict';

/**
 * 프로젝트 저장/불러오기 — _currentProject 를 .pflow 로 직렬화.
 *
 * 핵심 설계 (v2 — 보관 폴더 분리):
 *   - 저장 위치: ~/.flow-app/projects/<safe-name>.pflow (출력 폴더와 무관한 전용 폴더)
 *   - 자산 경로 (ttsAudioPath/imagePath/videoPath/videoSourceImage) 는 outputDir 기준
 *     상대경로로 저장. outputDir 자체는 .pflow 안에 명시 기록 → 보관 폴더와 자산 분리.
 *   - 외부 경로(outputDir 밖)는 절대경로 그대로 유지 (안전).
 *   - atomic write: <name>.pflow.tmp → rename. 백업 1개 (<name>.pflow.bak).
 *   - 로드 시 자산 파일 존재 검증 — 없으면 status='idle' 로 reset, 누락 통계 반환.
 *
 * 호환성:
 *   - 옛 .pflow (출력 폴더 안 project.pflow) 도 그대로 로드. outputDir 가 .pflow 안에
 *     없으면 path.dirname(filePath) 를 fallback.
 */

const fs = require('fs');
const path = require('path');
const os = require('os');

const FILE_NAME = 'project.pflow';
const BAK_NAME = 'project.pflow.bak';
const CURRENT_VERSION = 1;

const PROJECTS_DIR = path.join(os.homedir(), '.flow-app', 'projects');

function ensureProjectsDir() {
  try { fs.mkdirSync(PROJECTS_DIR, { recursive: true }); }
  catch (e) { console.error('[project-store] mkdir 실패:', e.message); }
  return PROJECTS_DIR;
}

function getProjectsDir() {
  ensureProjectsDir();
  return PROJECTS_DIR;
}

/** Windows/Unix 금지 문자 제거 + 공백 정리 + 확장자 제거 */
function _sanitizeName(name) {
  let s = String(name || '').trim();
  s = s.replace(/\.pflow$/i, '');
  s = s.replace(/[<>:"/\\|?*\x00-\x1f]/g, '_');
  s = s.replace(/\s+/g, ' ').trim();
  if (!s) s = 'project_' + Date.now();
  return s;
}

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
 * 프로젝트 저장.
 *
 * @param {object} project — window._currentProject
 * @param {object|string} [opts] — 옵션 (문자열이면 옛 시그니처 호환: targetDir 로 간주)
 *   opts.filePath  {string} — 명시적 저장 경로 (재저장용). proj.pflowPath 와 동일.
 *   opts.name      {string} — 새 저장명 (보관 폴더 안). filePath 보다 후순위.
 * @returns {{ path:string, size:number, sentencesCount:number, groupsCount:number, savedAt:string }}
 */
function saveProject(project, opts) {
  if (!project) throw new Error('project 가 null');

  // 옛 시그니처 호환: 두 번째 인자가 문자열이면 폴더 경로로 간주 (외부 직접 호출에 대비)
  if (typeof opts === 'string') {
    opts = { _legacyTargetDir: opts };
  }
  opts = opts || {};

  // 저장 위치 결정 우선순위:
  //   1) opts.filePath (명시 — 재저장/자동저장)
  //   2) project.pflowPath (이전에 저장한 위치 — 재저장)
  //   3) opts.name (새 이름 → 보관 폴더 안 새 파일)
  //   4) 자동 이름 (project.scriptFileName / project.name / 'project_<ts>') → 보관 폴더 안 새 파일
  //   5) opts._legacyTargetDir (호환)
  let target;
  if (opts.filePath) {
    target = opts.filePath;
  } else if (project.pflowPath && fs.existsSync(path.dirname(project.pflowPath))) {
    target = project.pflowPath;
  } else if (opts._legacyTargetDir) {
    target = path.join(opts._legacyTargetDir, FILE_NAME);
  } else {
    const rawName = opts.name
      || project.scriptFileName
      || project.name
      || `project_${new Date().toISOString().slice(0, 10)}`;
    const safe = _sanitizeName(rawName);
    // 사용자 정책: 같은 이름이 있으면 ' (2)' 같은 새 파일을 만들지 말고 같은 파일에 덮어쓴다.
    // (덮어쓰기 직전 <name>.pflow.bak 백업이 생성되므로 직전 상태는 1회 복구 가능)
    ensureProjectsDir();
    target = path.join(getProjectsDir(), safe + '.pflow');
  }

  const saveDir = path.dirname(target);
  if (!fs.existsSync(saveDir)) fs.mkdirSync(saveDir, { recursive: true });

  // 자산 경로 상대화는 outputDir 기준 (보관 폴더와 무관)
  const outDir = project.outputDir || project.imageOutputDir || null;

  // 깊은 복사 + 자산 경로 상대화
  const clone = JSON.parse(JSON.stringify(project));
  if (outDir) {
    for (const s of (clone.sentences || [])) {
      if (s.ttsAudioPath) s.ttsAudioPath = _toRel(s.ttsAudioPath, outDir);
    }
    for (const g of (clone.groups || [])) {
      if (g.imagePath)        g.imagePath        = _toRel(g.imagePath, outDir);
      if (g.videoPath)        g.videoPath        = _toRel(g.videoPath, outDir);
      if (g.videoSourceImage) g.videoSourceImage = _toRel(g.videoSourceImage, outDir);
    }
  }
  // pflowPath 는 저장 시점에 결정 — clone 에는 굳이 안 넣음 (외부에서 setter 로 갱신)
  delete clone.pflowPath;

  const payload = Object.assign({
    version: CURRENT_VERSION,
    savedAt: new Date().toISOString(),
  }, clone);
  if (outDir) payload.outputDir = outDir;

  // 백업 — 기존 .pflow 가 있으면 같은 폴더 안 <name>.pflow.bak 으로 1개 유지
  if (fs.existsSync(target)) {
    const bak = target.replace(/\.pflow$/i, '') + '.pflow.bak';
    try { fs.copyFileSync(target, bak); } catch (e) { /* 무시 */ }
  }

  // atomic write
  const tmp = target + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(payload, null, 2), 'utf-8');
  try {
    fs.renameSync(tmp, target);
  } catch (e) {
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

/** 보관 폴더 안 .pflow 파일 목록 (최신순). 로드/관리 UI 용. */
function listProjects() {
  ensureProjectsDir();
  try {
    const files = fs.readdirSync(PROJECTS_DIR);
    const items = files
      .filter(f => f.toLowerCase().endsWith('.pflow') && !f.toLowerCase().endsWith('.pflow.bak'))
      .map(f => {
        const full = path.join(PROJECTS_DIR, f);
        let stat;
        try { stat = fs.statSync(full); } catch { return null; }
        return { name: f.replace(/\.pflow$/i, ''), path: full, mtime: stat.mtimeMs, size: stat.size };
      })
      .filter(Boolean)
      .sort((a, b) => b.mtime - a.mtime);
    return items;
  } catch (e) {
    console.error('[project-store] listProjects 실패:', e.message);
    return [];
  }
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

  // 자산 기준 폴더(outDir) 결정:
  //   1) .pflow 안에 저장된 outputDir (v2 새 형식 — 보관 폴더와 자산 폴더 분리)
  //   2) path.dirname(filePath)  (v1 옛 형식 — .pflow 가 자산과 같은 폴더)
  const savedOutDir = (data.outputDir && fs.existsSync(data.outputDir)) ? data.outputDir : null;
  const outDir = savedOutDir || path.dirname(filePath);

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

  // outputDir 보존 — 저장된 값이 유효하면 그대로, 아니면 .pflow 위치(=옛 형식)로 fallback
  data.outputDir = outDir;
  // imageOutputDir 검증/추정
  if (!data.imageOutputDir || !fs.existsSync(data.imageOutputDir)) {
    const guess = path.join(outDir, 'images');
    if (fs.existsSync(guess)) data.imageOutputDir = guess;
  }
  // 로드된 .pflow 의 절대경로를 proj.pflowPath 에 기록 → 이후 자동저장/재저장 시 같은 위치 사용
  data.pflowPath = filePath;

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
  listProjects,
  getProjectsDir,
  ensureProjectsDir,
  PROJECTS_DIR,
  FILE_NAME,
  CURRENT_VERSION,
};
