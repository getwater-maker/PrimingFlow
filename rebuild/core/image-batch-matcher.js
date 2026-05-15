'use strict';

/**
 * 외부 이미지 파일 목록을 그룹 title 로 자동 매칭.
 *
 * 매칭 규칙:
 *   - groupTitle 에서 한글/영문 토큰과 숫자 토큰을 추출
 *     "장면 001" → ["장면", "001"]  /  "후킹" → ["후킹"]
 *   - 토큰 사이에는 비-한글/영문/숫자 문자(공백·_·-·[]) 만 허용
 *   - 숫자 토큰은 뒤에 오는 숫자가 없어야 함 (001 ≠ 0010)
 *   - title 이 null 인 그룹은 자동 매칭 불가 (수동 첨부 전용)
 */

/**
 * groupTitle 에 대한 정규식 생성.
 * @param {string} groupTitle
 * @returns {RegExp|null}
 */
function buildTitleMatcher(groupTitle) {
  if (!groupTitle) return null;
  const tokens = String(groupTitle).match(/[가-힣A-Za-z]+|\d+/g);
  if (!tokens || tokens.length === 0) return null;

  const escape = s => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const parts = tokens.map(t =>
    /^\d+$/.test(t)
      ? `${escape(t)}(?!\\d)`   // 숫자 뒤에 다른 숫자가 오면 불매칭
      : escape(t)
  );
  const pattern = parts.join('[^가-힣A-Za-z\\d]*');
  return new RegExp(pattern, 'i');
}

/**
 * 파일 목록을 그룹 title 기준으로 매칭.
 *
 * @param {Array<{id:string, num:number, title:string|null}>} groups
 * @param {Array<{name:string, path:string}>} files
 * @returns {{
 *   matches: Array<{
 *     groupId: string, groupNum: number, groupTitle: string,
 *     file: {name:string, path:string},
 *     multipleHits: boolean,
 *     candidates: Array<{name:string, path:string}>
 *   }>,
 *   skippedGroups: Array<{groupId:string, groupNum:number, groupTitle:string|null}>,
 *   unmatchedFiles: Array<{name:string, path:string}>
 * }}
 */
/**
 * 파일명에서 "그룹 N" / "group N" / "scene N" / 맨 앞 숫자 같은 패턴으로 그룹 번호 추출.
 * 매칭 후보:
 *   "그룹 01_..."   → 1
 *   "group 12 ..."  → 12
 *   "12_..."        → 12
 *   "scene_03..."   → 3
 * 매칭 실패 시 null.
 */
function extractGroupNumFromFilename(name) {
  if (!name) return null;
  // 확장자 제거
  const base = String(name).replace(/\.[a-z0-9]{1,5}$/i, '');
  // 1) 그룹/group/scene/장면 + 숫자
  let m = base.match(/(?:그룹|group|scene|장면|chapter|chap|ep|episode|씬)\s*[_\-]?\s*0*(\d{1,4})/i);
  if (m) return parseInt(m[1], 10);
  // 2) 맨 앞 숫자 (예: "01_제목", "12 - 제목")
  m = base.match(/^\s*0*(\d{1,4})\b/);
  if (m) return parseInt(m[1], 10);
  return null;
}

function matchImagesToGroups(groups, files) {
  const usedFiles = new Set();
  const matches = [];
  const skippedGroups = [];

  // 파일명 → 추출된 그룹 번호 사전 계산 (각 파일 1회)
  const fileNumIndex = files.map(f => ({ file: f, num: extractGroupNumFromFilename(f.name) }));

  for (const g of groups) {
    let candidates = [];
    let matchedBy = null;

    // 1) group.title 매칭 (대괄호 섹션 등 title 있는 그룹)
    if (g.title) {
      const re = buildTitleMatcher(g.title);
      if (re) {
        candidates = files.filter(f => !usedFiles.has(f.name) && re.test(f.name));
        if (candidates.length > 0) matchedBy = 'title';
      }
    }

    // 2) group.num 매칭 fallback — 일반 본론/도입부 그룹 (title 없음) 또는 title 매칭 0건
    if (candidates.length === 0 && Number.isFinite(g.num)) {
      candidates = fileNumIndex
        .filter(fi => fi.num === g.num && !usedFiles.has(fi.file.name))
        .map(fi => fi.file);
      if (candidates.length > 0) matchedBy = 'num';
    }

    if (candidates.length === 0) {
      skippedGroups.push({ groupId: g.id, groupNum: g.num, groupTitle: g.title || null });
    } else {
      const chosen = candidates[0];
      usedFiles.add(chosen.name);
      matches.push({
        groupId: g.id,
        groupNum: g.num,
        groupTitle: g.title || null,
        file: chosen,
        multipleHits: candidates.length > 1,
        candidates,
        matchedBy, // 'title' | 'num'
      });
    }
  }

  const unmatchedFiles = files.filter(f => !usedFiles.has(f.name));
  return { matches, skippedGroups, unmatchedFiles };
}

module.exports = { buildTitleMatcher, extractGroupNumFromFilename, matchImagesToGroups };
