'use strict';

/**
 * Gemini 2.5 Flash Image PoC 테스터
 *
 * 본격 통합과 분리된 가벼운 PoC. 결과를 ~/.flow-app/gemini-image-tests/<timestamp>/
 * 폴더에 격리 저장. 기존 outputDir / vrew-builder 와 무관.
 *
 * 호출:
 *   const Gemini = require('../image-engines/gemini-image-tester');
 *   const { dir } = await Gemini.test({
 *     koreanPrompts: ['한국어 1', '한국어 2'],
 *     onProgress: (i, total, status) => {},
 *     onResult:   (i, { ko, en, imagePath }) => {},
 *     onError:    (i, msg) => {},
 *   });
 *
 * 참고:
 *   - 번역은 flow-engine.js:3220 의 _translateToEnglish 와 동일 — translate.googleapis.com
 *     무료 endpoint. API 키 불필요, quota 무제한.
 *   - 이미지 API: https://ai.google.dev/gemini-api/docs/image-generation
 *   - 사용량 추적: gemini-usage-store.js 의 img_ok / img_429 카운터
 */

const fs = require('fs');
const path = require('path');
const os = require('os');
const https = require('https');

const SecretStore = require('../tts/secret-store');
const Usage = require('../tts/gemini-usage-store');
const { quietPostJson } = require('../tts/quiet-http');

const IMAGE_MODEL = 'gemini-3.1-flash-image-preview';  // Nano Banana 2
const TEST_ROOT = path.join(os.homedir(), '.flow-app', 'gemini-image-tests');

// flow-engine 의 _translateToEnglish 와 동일 — 무료 endpoint, 키 불필요
function translateToEnglish(koreanText) {
  return new Promise(resolve => {
    try {
      const text = String(koreanText || '').replace(/\n/g, ' ').substring(0, 300);
      if (!text) return resolve(null);
      const url = `https://translate.googleapis.com/translate_a/single?client=gtx&sl=ko&tl=en&dt=t&q=${encodeURIComponent(text)}`;
      https.get(url, (res) => {
        let data = '';
        res.on('data', (chunk) => data += chunk);
        res.on('end', () => {
          try {
            const parsed = JSON.parse(data);
            resolve(parsed[0].map(s => s[0]).join(''));
          } catch { resolve(null); }
        });
      }).on('error', () => resolve(null));
    } catch { resolve(null); }
  });
}

/**
 * Gemini Image API 1회 호출 + PNG 저장.
 * 성공: imagePath 반환. 실패: throw Error.
 */
async function generateOneImage(apiKey, englishPrompt, outPath) {
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${IMAGE_MODEL}:generateContent?key=${apiKey}`;
  const body = {
    contents: [{
      parts: [{ text: String(englishPrompt) }],
    }],
    generationConfig: {
      responseModalities: ['IMAGE'],
    },
  };

  const response = await quietPostJson(url, body, { timeoutMs: 120000 });

  if (!response.ok) {
    if (response.status === 429) {
      Usage.bump('img_429');
      throw new Error('한도 초과 (429) — 잠시 후 재시도');
    }
    const errText = await response.text().catch(() => '');
    throw new Error(`Gemini 이미지 API 실패 (${response.status}): ${errText.substring(0, 200)}`);
  }

  const json = await response.json().catch(() => null);
  if (!json) throw new Error('응답 JSON 파싱 실패');

  // 안전 필터 거부 감지
  const finishReason = json?.candidates?.[0]?.finishReason;
  if (finishReason === 'SAFETY' || finishReason === 'PROHIBITED_CONTENT') {
    throw new Error('안전 필터 거부 — 프롬프트 완화 필요');
  }

  // 이미지 데이터 추출 (parts 안에 inlineData 가 있는 part 를 찾음)
  const parts = json?.candidates?.[0]?.content?.parts || [];
  const imgPart = parts.find(p => p?.inlineData?.mimeType?.startsWith('image/'));
  const b64 = imgPart?.inlineData?.data;
  if (!b64) {
    // 디버그용 — 응답 전체를 콘솔에 출력
    try { console.warn('[gemini-image] 이미지 데이터 없음. 응답:', JSON.stringify(json).substring(0, 500)); } catch {}
    throw new Error('응답에 이미지 데이터 없음 (모델/payload 형식 변경 가능성)');
  }

  fs.writeFileSync(outPath, Buffer.from(b64, 'base64'));
  Usage.bump('img_ok');
  return outPath;
}

function ensureTestDir() {
  const ts = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  const dir = path.join(TEST_ROOT, ts);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function pad2(n) { return String(n).padStart(2, '0'); }

/**
 * PoC 메인 진입점.
 * @param {object} args
 * @param {string[]} args.koreanPrompts  - 한국어 프롬프트 배열
 * @param {function} [args.onProgress]   - (idx, total, statusText) 매 단계마다
 * @param {function} [args.onResult]     - (idx, { ko, en, imagePath }) 성공 시
 * @param {function} [args.onError]      - (idx, errMsg) 실패 시
 * @returns {Promise<{ dir: string, count: number, success: number, failed: number }>}
 */
async function test(args) {
  const koreanPrompts = Array.isArray(args && args.koreanPrompts) ? args.koreanPrompts : [];
  const onProgress = (args && args.onProgress) || (() => {});
  const onResult   = (args && args.onResult)   || (() => {});
  const onError    = (args && args.onError)    || (() => {});

  // API 키 가드
  const secret = SecretStore.get('gemini');
  if (!secret || !secret.key) {
    const e = new Error('API_KEY_MISSING');
    e.code = 'API_KEY_MISSING';
    throw e;
  }
  const apiKey = secret.key;

  if (koreanPrompts.length === 0) {
    const e = new Error('NO_PROMPTS');
    e.code = 'NO_PROMPTS';
    throw e;
  }

  const dir = ensureTestDir();
  const total = koreanPrompts.length;
  let success = 0;
  let failed = 0;

  for (let i = 0; i < total; i++) {
    const ko = koreanPrompts[i];
    try {
      onProgress(i, total, '한국어 → 영어 번역 중...');
      const en = (await translateToEnglish(ko)) || ko;  // 번역 실패 시 한국어 그대로

      onProgress(i, total, 'Gemini 이미지 생성 중...');
      const imagePath = path.join(dir, `${pad2(i + 1)}.png`);
      await generateOneImage(apiKey, en, imagePath);

      onResult(i, { ko, en, imagePath });
      success++;
    } catch (err) {
      const msg = (err && err.message) ? err.message : String(err);
      onError(i, msg);
      failed++;
      // 다음 그룹 계속 진행 (한 개 실패해도 PoC 평가 가능하게)
    }
  }

  // 메타 정보 저장 (사용자가 결과 분석 시 참조용)
  try {
    const meta = {
      timestamp: new Date().toISOString(),
      model: IMAGE_MODEL,
      total,
      success,
      failed,
      prompts: koreanPrompts,
    };
    fs.writeFileSync(path.join(dir, '_meta.json'), JSON.stringify(meta, null, 2), 'utf-8');
  } catch {}

  return { dir, count: total, success, failed };
}

module.exports = { test, IMAGE_MODEL, TEST_ROOT };
