/**
 * 대본 짝꿍 발음 사전 CRUD
 * 위치: <대본경로>.dict.json  (대본 파일과 동일 폴더)
 * 형식: { scriptName, createdAt, entries: [{source, pron}] }
 */

'use strict';

const fs = require('fs');
const path = require('path');

const NUMBER_RE = /\d+(?:[,.]\d+)*(?:\s*(?:년|월|일|회|호|번|차|시|분|초|개|명|원|만|억|조|세기|세대|살|대|위|km|m|kg))?/g;

function getDictPath(scriptFilePath) {
  const ext = path.extname(scriptFilePath);
  const base = ext ? scriptFilePath.slice(0, -ext.length) : scriptFilePath;
  return base + '.dict.json';
}

function load(scriptFilePath) {
  if (!scriptFilePath) return null;
  const dictPath = getDictPath(scriptFilePath);
  try {
    if (fs.existsSync(dictPath)) {
      const data = JSON.parse(fs.readFileSync(dictPath, 'utf-8'));
      if (data && Array.isArray(data.entries)) return data;
    }
  } catch (e) {
    console.error('[script-dict-store] 로드 실패:', e.message);
  }
  return null;
}

function save(scriptFilePath, data) {
  if (!scriptFilePath) return false;
  const dictPath = getDictPath(scriptFilePath);
  try {
    fs.writeFileSync(dictPath, JSON.stringify(data, null, 2), 'utf-8');
    return true;
  } catch (e) {
    console.error('[script-dict-store] 저장 실패:', e.message);
    return false;
  }
}

/**
 * 대본 텍스트에서 숫자 패턴 자동 추출 (중복 제거, 등장 순)
 * @param {string} scriptText
 * @returns {string[]}
 */
function detectNumbers(scriptText) {
  if (!scriptText) return [];
  const matches = String(scriptText).match(NUMBER_RE) || [];
  const seen = new Set();
  const result = [];
  for (const m of matches) {
    const t = m.trim();
    if (t && !seen.has(t)) {
      seen.add(t);
      result.push(t);
    }
  }
  return result;
}

/**
 * 숫자 패턴 + 앞뒤 문맥 추출 (첫 등장 기준)
 * @param {string} scriptText
 * @param {number} contextChars  앞뒤 최대 문자 수
 * @returns {Array<{source:string, before:string, after:string, context:string}>}
 */
function detectNumbersWithContext(scriptText, contextChars = 14) {
  if (!scriptText) return [];
  const text = String(scriptText);
  const seen = new Set();
  const result = [];
  let match;
  const re = new RegExp(NUMBER_RE.source, 'g');
  while ((match = re.exec(text)) !== null) {
    let source = match[0].trim();
    if (!source) continue;

    // 순수 숫자(단위 없음)이면 바로 뒤 한글 1자가 단위인지 검사.
    // 단위 다음 글자가 단어 종결자(공백/구두점/끝)여야 진짜 단위로 간주.
    //   "8남 " → "8남" (단위 OK)   /   "8남자" → "8" (남자는 단어 일부)
    if (/^[\d,.]+$/.test(source)) {
      const endIdx = match.index + match[0].length;
      const slice = text.slice(endIdx, endIdx + 2);
      const m1 = slice.match(/^([가-힣])/);
      if (m1) {
        const next = slice.charAt(1);
        if (next === '' || /[\s.,!?;:'"()\[\]·‐-―~〜～]/.test(next)) {
          source = source + m1[1];
        }
      }
    }
    // 방어적 정리 — 어떤 경로로든 같은 한글이 끝에 중복되면 한 번으로 압축
    //   "20여여" → "20여",  "10리리" → "10리"
    source = source.replace(/^([\d,.]+)([가-힣])\2+$/, '$1$2');

    if (seen.has(source)) continue;
    seen.add(source);
    const idx = match.index;
    const rawBefore = text.slice(Math.max(0, idx - contextChars), idx);
    // source 가 NUMBER_RE 매치보다 길면(단위 추가됐으면) after 시작점도 뒤로 — 표시 중복 방지
    const _afterStart = idx + match[0].length + Math.max(0, source.length - match[0].length);
    const rawAfter  = text.slice(_afterStart, Math.min(text.length, _afterStart + contextChars));
    // 줄바꿈 이후는 컨텍스트로 의미 없음 — 같은 줄 범위만 사용
    // 그리고 문장 종결자(.!?。) 이후만 표시 — 앞 문장 잔재 제거
    //   예: "장수 장보였습니다. 적군 8~9만 명이..." 의 8~9만 컨텍스트 →
    //        "적군 " 만 보존 (앞 문장 "장수 장보였습니다." 제거)
    const before = rawBefore
      .replace(/[\r\n][\s\S]*$/, '')              // 줄바꿈 이후 제거
      .replace(/^[\s\S]*[.!?。][\s ]*/, '')  // 마지막 문장 종결자(+공백) 직전까지 제거
      .replace(/\s+/g, ' ').trimStart();
    const after  = rawAfter.replace(/[\r\n][\s\S]*/, '').replace(/\s+/g, ' ').trimEnd();
    result.push({ source, before, after, context: `${before}${source}${after}` });
  }
  return result;
}

/**
 * sentence별 숫자 감지 — 클립번호(sentenceNum) 와 sentenceId 함께 반환.
 * #/## 마크다운 헤더와 [섹션] 마커는 sentence-splitter 가 이미 제외했으므로
 * sentence 배열에는 포함되지 않음 → 자동으로 검색 대상에서 빠짐.
 *
 * 같은 source가 여러 sentence에 등장하면 첫 등장 sentence만 결과에 포함.
 */
function detectNumbersBySentence(sentences, contextChars = 14) {
  if (!Array.isArray(sentences)) return [];
  const seen = new Set();
  const results = [];
  for (const s of sentences) {
    const text = String(s.text || '');
    if (!text) continue;
    const re = new RegExp(NUMBER_RE.source, 'g');
    let match;
    while ((match = re.exec(text)) !== null) {
      let source = match[0].trim();
      if (!source) continue;

      if (/^[\d,.]+$/.test(source)) {
        const endIdx = match.index + match[0].length;
        const slice = text.slice(endIdx, endIdx + 2);
        const m1 = slice.match(/^([가-힣])/);
        if (m1) {
          const next = slice.charAt(1);
          if (next === '' || /[\s.,!?;:'"()\[\]·‐-―~〜～]/.test(next)) {
            source = source + m1[1];
          }
        }
      }
      source = source.replace(/^([\d,.]+)([가-힣])\2+$/, '$1$2');

      if (seen.has(source)) continue;
      seen.add(source);

      const idx = match.index;
      const rawBefore = text.slice(Math.max(0, idx - contextChars), idx);
      // source 가 NUMBER_RE 매치보다 길면(단위 추가됐으면) after 시작점도 뒤로 — 표시 중복 방지
    const _afterStart = idx + match[0].length + Math.max(0, source.length - match[0].length);
    const rawAfter  = text.slice(_afterStart, Math.min(text.length, _afterStart + contextChars));
      const before = rawBefore
        .replace(/[\r\n][\s\S]*$/, '')
        .replace(/^[\s\S]*[.!?。][\s ]*/, '')
        .replace(/\s+/g, ' ').trimStart();
      const after  = rawAfter.replace(/[\r\n][\s\S]*/, '').replace(/\s+/g, ' ').trimEnd();
      results.push({
        source, before, after,
        context: `${before}${source}${after}`,
        sentenceId: s.id,
        sentenceNum: s.num,
      });
    }
  }
  return results;
}

module.exports = { getDictPath, load, save, detectNumbers, detectNumbersWithContext, detectNumbersBySentence };
