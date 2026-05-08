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
function matchImagesToGroups(groups, files) {
  const usedFiles = new Set();
  const matches = [];
  const skippedGroups = [];

  for (const g of groups) {
    if (!g.title) {
      skippedGroups.push({ groupId: g.id, groupNum: g.num, groupTitle: null });
      continue;
    }
    const re = buildTitleMatcher(g.title);
    if (!re) {
      skippedGroups.push({ groupId: g.id, groupNum: g.num, groupTitle: g.title });
      continue;
    }

    const candidates = files.filter(f => re.test(f.name));
    if (candidates.length === 0) {
      skippedGroups.push({ groupId: g.id, groupNum: g.num, groupTitle: g.title });
    } else {
      const chosen = candidates[0];
      usedFiles.add(chosen.name);
      matches.push({
        groupId: g.id,
        groupNum: g.num,
        groupTitle: g.title,
        file: chosen,
        multipleHits: candidates.length > 1,
        candidates,
      });
    }
  }

  const unmatchedFiles = files.filter(f => !usedFiles.has(f.name));
  return { matches, skippedGroups, unmatchedFiles };
}

module.exports = { buildTitleMatcher, matchImagesToGroups };
