/**
 * 이미지 스타일 프리셋 스토어
 * 위치: ~/.flow-app/styles.json (사용자 추가/수정 스타일만 저장)
 *
 * 정책:
 *  - 기본 스타일은 코드에 시드 (BUILT_IN_STYLES) — 항상 존재, 수정/삭제 불가.
 *  - 사용자 스타일만 ~/.flow-app/styles.json 에 저장 — 자유롭게 추가/수정/삭제.
 *  - loadAll() 은 기본 + 사용자 합쳐서 반환 (기본 먼저, 사용자 다음).
 */

const fs = require('fs');
const path = require('path');
const os = require('os');

const STORE_DIR = path.join(os.homedir(), '.flow-app');
const STORE_PATH = path.join(STORE_DIR, 'styles.json');

// 기본 28개 스타일 — flow-engine.js 의 옛 STYLE_PROMPTS 객체에서 이관
const BUILT_IN_STYLES = [
  { id: 'k-webtoon',         name: '한국 웹툰',           prompt: 'beautiful Korean webtoon style, manhwa art, soft shading, detailed characters, emotional expressions, Korean comic illustration, clean lineart, pastel colors' },
  { id: 'webtoon-illust',    name: '웹툰 일러스트',       prompt: 'webtoon illustration style, digital painting, semi-realistic, vivid colors, detailed background, Korean manhwa inspired, clean composition' },
  { id: 'cinematic',         name: '시네마틱 (영화풍)',   prompt: 'cinematic film still, dramatic lighting, movie scene' },
  { id: 'photorealistic',    name: '포토리얼 (실사)',     prompt: 'photorealistic photography, high detail, natural lighting, 8K' },
  { id: 'illustration',      name: '일러스트',            prompt: 'digital illustration, clean lines, warm colors, detailed' },
  { id: 'anime',             name: '애니메이션',          prompt: 'anime style illustration, vibrant colors, expressive characters, Japanese animation' },
  { id: 'watercolor',        name: '수채화',              prompt: 'traditional watercolor painting, aquarelle, wet-on-wet technique, visible paper texture, soft pastel color washes, flowing translucent pigments, hand-painted on cotton paper, loose brush strokes, bleeding colors, artistic fine art, NOT digital illustration, NOT line art, NOT webtoon, NOT manhwa, NOT anime' },
  { id: 'biblical-watercolor', name: '수채화 (성경시대)', prompt: 'traditional watercolor painting of ancient biblical era, aquarelle, wet-on-wet technique, visible paper texture, soft earth-tone washes (ochre, sand, olive, terracotta), flowing translucent pigments, hand-painted on cotton paper, loose brush strokes, ancient Middle Eastern setting, biblical figures in flowing robes and tunics, head coverings, sandals, bearded elders, Holy Land landscape with olive trees and stone buildings, reverent atmosphere, sacred scripture illustration, fine art, NOT digital illustration, NOT line art, NOT webtoon, NOT manhwa, NOT anime, NOT modern clothing, NOT Korean historical drama' },
  { id: 'ink',               name: '수묵화',              prompt: 'ink wash painting, traditional, minimalist, elegant brush strokes' },
  { id: 'oil',               name: '유화',                prompt: 'oil painting, classical, rich colors, elegant brushwork, fine art' },
  { id: 'fantasy',           name: '판타지 아트',         prompt: 'fantasy art, epic scene, magical atmosphere, detailed environment, concept art' },
  { id: 'noir',              name: '필름 누아르',         prompt: 'film noir, black and white, high contrast, shadows, dramatic mood, vintage' },
  { id: 'pixel',             name: '픽셀 아트',           prompt: 'pixel art, retro game style, 16-bit, vibrant colors, detailed sprites' },
  { id: 'comic',             name: '만화/코믹',           prompt: 'comic book style, bold outlines, dynamic composition, vivid colors, action panels' },
  { id: '3d',                name: '3D 렌더링',           prompt: '3D rendered scene, ray tracing, realistic materials, cinematic lighting, Unreal Engine' },
  { id: 'minecraft',         name: '마인크래프트',        prompt: 'Minecraft game screenshot, voxel art, blocky 3D world, cubic characters, pixel textures, in-game capture' },
  { id: 'stickman',          name: '졸라맨 (스틱맨)',     prompt: 'simple stick figure drawing, black lines on white background, minimalist doodle, hand-drawn sketch style, funny stick characters' },
  { id: 'simpsons',          name: '심슨 가족',           prompt: 'The Simpsons cartoon style, yellow skin characters, bold outlines, bright colors, animated TV show, Matt Groening style' },
  { id: 'ghibli',            name: '지브리 (미야자키)',   prompt: 'Studio Ghibli anime style, soft watercolor backgrounds, warm lighting, detailed nature, Hayao Miyazaki inspired' },
  { id: 'disney',            name: '디즈니/픽사',         prompt: 'Disney 3D animation style, Pixar-like rendering, expressive characters, vibrant colors, family friendly' },
  { id: 'chibi',             name: '치비 (귀여운)',       prompt: 'chibi anime style, cute super-deformed characters, big eyes, small body, kawaii, pastel colors' },
  { id: 'retro',             name: '레트로 80s',          prompt: 'retro 80s synthwave, neon colors, grid landscape, sunset, VHS aesthetic, vaporwave' },
  { id: 'sketch',            name: '연필 스케치',         prompt: 'pencil sketch drawing, graphite on paper, detailed cross-hatching, artistic hand-drawn' },
  { id: 'pop',               name: '팝아트',              prompt: 'pop art style, Roy Lichtenstein, bold colors, halftone dots, comic book aesthetic, Andy Warhol inspired' },
];

function _loadUserStyles() {
  try {
    if (fs.existsSync(STORE_PATH)) {
      const data = JSON.parse(fs.readFileSync(STORE_PATH, 'utf-8'));
      if (Array.isArray(data)) return data;
    }
  } catch (e) {
    console.error('[style-store] 사용자 스타일 로드 실패:', e.message);
  }
  return [];
}

function _saveUserStyles(userStyles) {
  try {
    fs.mkdirSync(STORE_DIR, { recursive: true });
    fs.writeFileSync(STORE_PATH, JSON.stringify(userStyles, null, 2), 'utf-8');
    return true;
  } catch (e) {
    console.error('[style-store] 사용자 스타일 저장 실패:', e.message);
    return false;
  }
}

/** 기본 + 사용자 모든 스타일 반환. 각 항목에 isBuiltIn 플래그 포함. */
function loadAll() {
  const user = _loadUserStyles();
  const result = BUILT_IN_STYLES.map(s => ({ ...s, isBuiltIn: true }));
  for (const u of user) {
    result.push({ ...u, isBuiltIn: false });
  }
  return result;
}

function getById(id) {
  return loadAll().find(s => s.id === id) || null;
}

/** style id → 영문 prompt. 없으면 null. */
function getPrompt(id) {
  const s = getById(id);
  return s ? s.prompt : null;
}

function isBuiltIn(id) {
  return BUILT_IN_STYLES.some(s => s.id === id);
}

/** 사용자 스타일 추가. style = { name, prompt }. 성공 시 새 스타일 객체 반환. */
function add(style) {
  const name = String(style.name || '').trim();
  const prompt = String(style.prompt || '').trim();
  if (!name || !prompt) return null;
  const id = style.id || ('user_' + Date.now() + '_' + Math.random().toString(36).slice(2, 6));
  const newStyle = { id, name, prompt };
  const user = _loadUserStyles();
  user.push(newStyle);
  _saveUserStyles(user);
  return { ...newStyle, isBuiltIn: false };
}

/** 사용자 스타일 수정 (기본 스타일은 수정 불가). */
function update(id, patch) {
  if (isBuiltIn(id)) return null;
  const user = _loadUserStyles();
  const idx = user.findIndex(s => s.id === id);
  if (idx < 0) return null;
  const updated = {
    ...user[idx],
    ...(patch.name != null ? { name: String(patch.name).trim() } : {}),
    ...(patch.prompt != null ? { prompt: String(patch.prompt).trim() } : {}),
  };
  user[idx] = updated;
  _saveUserStyles(user);
  return { ...updated, isBuiltIn: false };
}

/** 사용자 스타일 삭제 (기본 스타일은 삭제 불가). */
function remove(id) {
  if (isBuiltIn(id)) return false;
  const user = _loadUserStyles();
  const filtered = user.filter(s => s.id !== id);
  if (filtered.length === user.length) return false;   // 존재 안 함
  _saveUserStyles(filtered);
  return true;
}

module.exports = { loadAll, getById, getPrompt, isBuiltIn, add, update, remove, STORE_PATH, BUILT_IN_STYLES };
