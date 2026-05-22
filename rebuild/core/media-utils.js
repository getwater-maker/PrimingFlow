/**
 * media-utils — ffmpeg-static 바이너리를 spawn 으로 호출하는 얇은 래퍼.
 * 영상→mp3 추출, 임의 입력→OmniVoice 표준 WAV(24kHz/16bit/mono) 변환·자르기.
 *
 * Electron asar 패킹 시 ffmpeg.exe 는 app.asar.unpacked 에 풀려 있어야 spawn 가능.
 * package.json 의 asarUnpack 에 `node_modules/ffmpeg-static/**` 등록되어 있음.
 */

const fs = require('fs');
const path = require('path');
const os = require('os');
const { spawn } = require('child_process');
const crypto = require('crypto');

let _ffmpegPath = null;
try {
  _ffmpegPath = require('ffmpeg-static');
  if (_ffmpegPath && _ffmpegPath.includes('app.asar') && !_ffmpegPath.includes('app.asar.unpacked')) {
    _ffmpegPath = _ffmpegPath.replace('app.asar', 'app.asar.unpacked');
  }
} catch (_) {}

function getFfmpegPath() {
  return _ffmpegPath;
}

function _ensureFfmpeg() {
  if (!_ffmpegPath || !fs.existsSync(_ffmpegPath)) {
    throw new Error('ffmpeg-static 바이너리를 찾을 수 없습니다. npm install 후 다시 시도하세요.');
  }
}

/**
 * 충돌 안 나는 임시 파일 경로. 호출자가 파일 생성을 ffmpeg 에 위임하므로 경로만 반환.
 */
function tmpFile(ext) {
  const safeExt = String(ext || '.bin').replace(/^\.?/, '.');
  const name = 'pf-media-' + Date.now() + '-' + crypto.randomBytes(4).toString('hex') + safeExt;
  return path.join(os.tmpdir(), name);
}

/**
 * ffmpeg 를 spawn 하여 종료를 기다림. stderr 누적해 실패 시 에러 메시지에 포함.
 * @param {string[]} args
 * @returns {Promise<void>}
 */
function _runFfmpeg(args) {
  _ensureFfmpeg();
  return new Promise((resolve, reject) => {
    let stderr = '';
    const child = spawn(_ffmpegPath, args, { stdio: ['ignore', 'ignore', 'pipe'] });
    child.stderr.on('data', (chunk) => {
      // stderr 가 누적되면 메모리 폭주 위험 — 마지막 ~16KB 만 유지
      stderr += chunk.toString();
      if (stderr.length > 16384) stderr = stderr.slice(-16384);
    });
    child.on('error', (e) => reject(new Error('ffmpeg 실행 실패: ' + e.message)));
    child.on('close', (code) => {
      if (code === 0) return resolve();
      const tail = stderr.split('\n').slice(-6).join('\n');
      reject(new Error(`ffmpeg 종료 코드 ${code}\n${tail}`));
    });
  });
}

/**
 * 동영상에서 오디오 트랙만 mp3 로 추출 (192k, 원본 샘플레이트 유지).
 * @param {string} videoPath - 입력 동영상 (mp4/mov/webm/mkv 등)
 * @param {string} outMp3Path - 출력 mp3 절대경로
 */
async function extractAudioMp3(videoPath, outMp3Path) {
  if (!videoPath || !fs.existsSync(videoPath)) throw new Error('동영상 파일을 찾을 수 없습니다: ' + videoPath);
  await _runFfmpeg([
    '-y',
    '-i', videoPath,
    '-vn',
    '-acodec', 'libmp3lame',
    '-b:a', '192k',
    outMp3Path,
  ]);
  if (!fs.existsSync(outMp3Path)) throw new Error('mp3 출력 파일이 생성되지 않았습니다.');
  return outMp3Path;
}

/**
 * 임의 오디오/영상 입력 → OmniVoice 표준 참조음성 WAV (24kHz / 16bit / mono).
 * startSec / endSec 둘 다 주어지면 그 구간만 자르고, 없으면 전체 변환.
 *
 * volumeMultiplier 가 1.0 이 아니면 ffmpeg volume 필터 적용 + alimiter 로 클리핑 방지.
 * (예: 2.0 = 두 배 증폭, 0.5 = 절반 감쇄)
 *
 * @param {string} inPath
 * @param {string} outWavPath
 * @param {{ startSec?: number, endSec?: number, volumeMultiplier?: number }} [opts]
 */
async function convertToRefWav(inPath, outWavPath, opts = {}) {
  if (!inPath || !fs.existsSync(inPath)) throw new Error('입력 파일을 찾을 수 없습니다: ' + inPath);
  const args = ['-y'];
  // -ss 를 -i 앞에 두면 빠른 시킹 (정확도 약간 떨어짐) — 입력 뒤에 두면 정확하지만 느림.
  // 짧은 참조음성이라 정확도 우선, -i 뒤에 배치.
  args.push('-i', inPath);
  if (typeof opts.startSec === 'number' && opts.startSec > 0) {
    args.push('-ss', String(opts.startSec));
  }
  if (typeof opts.endSec === 'number' && opts.endSec > 0) {
    args.push('-to', String(opts.endSec));
  }
  // 오디오 필터 — 볼륨 조정 + 클리핑 방지 리미터
  const vol = (typeof opts.volumeMultiplier === 'number' && opts.volumeMultiplier > 0) ? opts.volumeMultiplier : 1.0;
  if (Math.abs(vol - 1.0) > 0.001) {
    // alimiter: 최종 진폭 0.95 (-0.45dB) 이하로 강제 — 볼륨 증폭 시 클리핑(찢어진 소리) 방지
    args.push('-af', `volume=${vol.toFixed(3)},alimiter=limit=0.95`);
  }
  args.push(
    '-vn',
    '-ar', '24000',
    '-ac', '1',
    '-acodec', 'pcm_s16le',
    outWavPath,
  );
  await _runFfmpeg(args);
  if (!fs.existsSync(outWavPath)) throw new Error('WAV 출력 파일이 생성되지 않았습니다.');
  return outWavPath;
}

module.exports = {
  getFfmpegPath,
  tmpFile,
  extractAudioMp3,
  convertToRefWav,
};
