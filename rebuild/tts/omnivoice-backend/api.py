"""
OmniVoice FastAPI 래퍼 서버
- OmniVoice 라이브러리를 HTTP API로 노출
- 엔진 매니저가 subprocess로 실행하여 관리
- /upload-ref-audio : 참조음성 토큰 캐시 (voxcpm-provider 동일 패턴)
"""

import argparse
import asyncio
import hashlib
import io
import json
import logging
import os
import re
import sys
import tempfile
import wave
from pathlib import Path

import numpy as np
import torch
import uvicorn
from fastapi import FastAPI, File, Form, HTTPException, UploadFile
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import Response
from pydantic import BaseModel, Field

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s [%(levelname)s] %(message)s",
)
logger = logging.getLogger("omnivoice-api")

# /health 폴링 로그는 콘솔 노이즈만 유발 — 걸러냄
class _HealthFilter(logging.Filter):
    def filter(self, record):
        return "/health" not in record.getMessage()
logging.getLogger("uvicorn.access").addFilter(_HealthFilter())

app = FastAPI(title="OmniVoice API", version="1.2.0")

# Electron renderer(file://)에서 fetch 시 CORS preflight 통과 필요
# X-API-Key 헤더도 허용 — 인증 활성화 시 클라이언트가 보냄
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_methods=["GET", "PUT", "POST", "DELETE", "OPTIONS"],
    allow_headers=["Content-Type", "X-API-Key"],
)

# ── 간단한 API 키 인증 (B 옵션) ──────────────────────
# 환경변수 FLOW_API_KEY 가 설정되면 활성화. 빈 값이면 비활성 (단독/신뢰 LAN 사용 시).
# 헤더 X-API-Key 또는 쿼리 ?api_key= 둘 다 허용.
# /health 만 인증 제외 — 모니터링/로드밸런서가 헤더 없이 체크 가능하도록.
_API_KEY = (os.environ.get("FLOW_API_KEY") or "").strip()
_PUBLIC_PATHS = {"/health"}

@app.middleware("http")
async def _api_key_middleware(request, call_next):
    if not _API_KEY:
        return await call_next(request)
    if request.method == "OPTIONS":
        return await call_next(request)
    if request.url.path in _PUBLIC_PATHS:
        return await call_next(request)
    sent = request.headers.get("X-API-Key", "") or request.query_params.get("api_key", "")
    if sent != _API_KEY:
        from fastapi.responses import JSONResponse
        return JSONResponse(
            status_code=401,
            content={"error": "Unauthorized — X-API-Key header required"},
        )
    return await call_next(request)

if _API_KEY:
    logger.info("API 키 인증 활성화 (헤더 X-API-Key 필요, /health 제외)")
else:
    logger.info("API 키 인증 비활성화 — 신뢰 LAN/단독 사용 모드")

# 발음 사전 공유 저장소 경로 및 write lock
_DICT_PATH = Path(
    os.environ.get("FLOW_DICT_PATH")
    or str(Path.home() / ".flow-app" / "omnivoice-dict.shared.json")
)
_dict_lock = asyncio.Lock()

# 전역 모델 인스턴스
_model = None
_model_loaded = False
_asr_loaded = False

# 참조음성 토큰 캐시 {sha256_16: file_path}
_REF_AUDIO_DIR = Path(tempfile.gettempdir()) / "omnivoice_ref"
_ref_token_cache: dict = {}


# ── 참조음성 업로드 ────────────────────────────────

@app.post("/upload-ref-audio")
async def upload_ref_audio(file: UploadFile = File(...)):
    """참조음성 파일을 서버에 업로드하고 토큰을 반환한다."""
    data = await file.read()
    sha = hashlib.sha256(data).hexdigest()[:16]

    if sha in _ref_token_cache and os.path.exists(_ref_token_cache[sha]):
        logger.info("참조음성 캐시 히트: %s", sha)
        return {"token": sha}

    _REF_AUDIO_DIR.mkdir(parents=True, exist_ok=True)
    suffix = Path(file.filename or "ref.wav").suffix or ".wav"
    dest = _REF_AUDIO_DIR / f"ref_{sha}{suffix}"
    dest.write_bytes(data)

    _ref_token_cache[sha] = str(dest)
    logger.info("참조음성 저장: %s → %s", sha, dest)
    return {"token": sha}


def _resolve_ref_audio(ref_token, ref_audio):
    """ref_token 또는 ref_audio 중 유효한 경로를 반환한다."""
    if ref_token:
        path = _ref_token_cache.get(ref_token)
        if path and os.path.exists(path):
            return path
        logger.warning("ref_token 없음 또는 파일 소실: %s", ref_token)
    return ref_audio


def _apply_seed(seed):
    """결정적 합성을 위해 모든 RNG 시드 동기화. seed 가 None 이면 no-op."""
    if seed is None:
        return
    import random as _random
    try:
        torch.manual_seed(int(seed))
        if torch.cuda.is_available():
            torch.cuda.manual_seed_all(int(seed))
        np.random.seed(int(seed) & 0xFFFFFFFF)
        _random.seed(int(seed))
    except Exception as e:
        logger.warning("시드 적용 실패: %s", e)


# ── 요청/응답 모델 ─────────────────────────────────

class TTSRequest(BaseModel):
    """TTS 합성 요청"""
    text: str = Field(..., description="합성할 텍스트")
    ref_audio: str = Field(None, description="참조 음성 파일 경로")
    ref_token: str = Field(None, description="업로드된 참조음성 토큰")
    ref_text: str = Field(None, description="참조 음성 텍스트")
    instruct: str = Field(None, description="음색 설명 (Voice Design 모드)")
    speed: float = Field(1.0, description="속도 배율 (>1.0 빠름, <1.0 느림)")
    num_step: int = Field(32, description="디퓨전 스텝 수 (16 또는 32)")
    guidance_scale: float = Field(2.0, description="음색 일치도 (1.0~4.0)")
    t_shift: float = Field(0.1, description="시간 이동 (0.0~0.3)")
    class_temperature: float = Field(0.0, description="샘플링 온도 (0=결정적, 높을수록 창의적)")
    denoise: bool = Field(True, description="노이즈 제거 토큰 추가")
    audio_chunk_duration: float = Field(15.0, description="긴 텍스트 분할 길이 (초)")
    audio_chunk_threshold: float = Field(30.0, description="분할 시작 임계치 (초)")
    language: str = Field(None, description="언어 ISO 코드 (예: 'ko','en','ja'). None=자동감지")
    duration: float = Field(None, description="목표 오디오 길이(초). speed와 동시 지정 불가(이쪽이 우선)")
    layer_penalty_factor: float = Field(5.0, description="레이어 페널티 (고급)")
    position_temperature: float = Field(5.0, description="위치 온도 (고급)")
    postprocess_output: bool = Field(True, description="생성 후처리")
    seed: int = Field(None, description="시드 (지정 시 결정적 합성 — 같은 입력 + 같은 시드 = 같은 결과)")


class TTSBatchRequest(BaseModel):
    """TTS 배치 합성 요청 — 여러 문장을 한 번에 처리 (base64 반환)"""
    texts: list = Field(..., description="합성할 텍스트 목록")
    ref_audio: str = Field(None, description="참조 음성 파일 경로 (전체 공유)")
    ref_token: str = Field(None, description="업로드된 참조음성 토큰 (전체 공유)")
    ref_text: str = Field(None, description="참조 음성 텍스트 (전체 공유)")
    instruct: str = Field(None, description="음색 설명 (Voice Design 모드)")
    speed: float = Field(1.0, description="속도 배율")
    num_step: int = Field(32, description="디퓨전 스텝 수")
    guidance_scale: float = Field(2.0)
    t_shift: float = Field(0.1)
    class_temperature: float = Field(0.0)
    denoise: bool = Field(True)
    audio_chunk_duration: float = Field(15.0)
    audio_chunk_threshold: float = Field(30.0)
    language: str = Field(None, description="언어 ISO 코드 (예: 'ko','en','ja'). None=자동감지")
    duration: float = Field(None, description="목표 오디오 길이(초). speed와 동시 지정 불가(이쪽이 우선)")
    layer_penalty_factor: float = Field(5.0, description="레이어 페널티 (고급)")
    position_temperature: float = Field(5.0, description="위치 온도 (고급)")
    postprocess_output: bool = Field(True, description="생성 후처리")
    seed: int = Field(None, description="시드 (배치 전체 공유)")


class ASRRequest(BaseModel):
    """ASR 요청 (참조음성 텍스트 자동 추출)"""
    audio_path: str = Field(..., description="음성 파일 경로")


# ── 엔드포인트 ──────────────────────────────────────

@app.get("/health")
async def health():
    """헬스 체크 — 모델 로드 완료 시 200, 미완료 시 503"""
    if _model_loaded:
        return {"status": "ok"}
    raise HTTPException(status_code=503, detail="모델 로딩 중")


def _dict_version(entries: list) -> str:
    """entries JSON의 sha256 앞 8자 — stale 감지용"""
    raw = json.dumps(entries, ensure_ascii=False, sort_keys=True).encode()
    return hashlib.sha256(raw).hexdigest()[:8]


def _read_dict() -> list:
    if _DICT_PATH.exists():
        try:
            data = json.loads(_DICT_PATH.read_text(encoding="utf-8"))
            if isinstance(data, list):
                return data
            if isinstance(data, dict) and "entries" in data:
                return data["entries"]
        except Exception:
            pass
    return []


def _write_dict(entries: list):
    """atomic write — tmp → os.replace"""
    _DICT_PATH.parent.mkdir(parents=True, exist_ok=True)
    tmp = str(_DICT_PATH) + ".tmp"
    with open(tmp, "w", encoding="utf-8") as f:
        json.dump(entries, f, ensure_ascii=False, indent=2)
    os.replace(tmp, str(_DICT_PATH))


@app.get("/dict")
async def get_dict():
    """LAN 공유 전역 발음 사전 조회"""
    async with _dict_lock:
        entries = _read_dict()
    from datetime import datetime, timezone
    return {
        "entries": entries,
        "version": _dict_version(entries),
        "updatedAt": datetime.now(timezone.utc).isoformat(),
    }


class DictPutRequest(BaseModel):
    entries: list = Field(default_factory=list)


@app.put("/dict")
async def put_dict(req: DictPutRequest):
    """LAN 공유 전역 발음 사전 저장 (Last-Write-Wins, atomic)"""
    async with _dict_lock:
        _write_dict(req.entries)
        entries = req.entries
    from datetime import datetime, timezone
    logger.info("발음 사전 저장: %d건", len(entries))
    return {
        "entries": entries,
        "version": _dict_version(entries),
        "updatedAt": datetime.now(timezone.utc).isoformat(),
    }


# ── 참조음성 공유 저장소 ──────────────────────────────────────────

@app.get("/languages")
async def list_languages():
    """OmniVoice가 지원하는 언어 ISO 코드 전체 목록"""
    if not _model_loaded or _model is None:
        raise HTTPException(status_code=503, detail="모델이 아직 로드되지 않았습니다")
    try:
        codes = sorted(list(_model.supported_language_ids()))
    except Exception as e:
        logger.error("언어 목록 조회 실패: %s", e)
        raise HTTPException(status_code=500, detail=f"언어 목록 조회 실패: {e}")
    return {"status": "ok", "count": len(codes), "codes": codes}


@app.post("/tts")
async def synthesize(req: TTSRequest):
    """텍스트를 음성으로 변환하여 WAV 바이트를 반환한다."""
    global _model
    if not _model_loaded or _model is None:
        raise HTTPException(status_code=503, detail="모델이 아직 로드되지 않았습니다")

    try:
        kwargs = {
            "text": req.text,
            "num_step": req.num_step,
            "guidance_scale": req.guidance_scale,
            "t_shift": req.t_shift,
            "class_temperature": req.class_temperature,
            "denoise": req.denoise,
            "audio_chunk_duration": req.audio_chunk_duration,
            "audio_chunk_threshold": req.audio_chunk_threshold,
            "layer_penalty_factor": req.layer_penalty_factor,
            "position_temperature": req.position_temperature,
            "postprocess_output": req.postprocess_output,
        }
        if req.duration is not None:
            kwargs["duration"] = req.duration
        else:
            kwargs["speed"] = req.speed
        if req.language:
            kwargs["language"] = req.language

        # ref_token 우선 → ref_audio 경로로 해석
        resolved_ref = _resolve_ref_audio(req.ref_token, req.ref_audio)
        if resolved_ref and req.ref_text:
            kwargs["ref_audio"] = resolved_ref
            kwargs["ref_text"] = req.ref_text
        elif req.instruct:
            kwargs["instruct"] = req.instruct

        mode = "Voice Clone" if "ref_audio" in kwargs else "Voice Design" if "instruct" in kwargs else "Auto"
        _apply_seed(req.seed)
        logger.info(
            "TTS 합성 시작 [%s]: text=%s, speed=%.1f, num_step=%d, seed=%s",
            mode, req.text[:50], req.speed, req.num_step,
            req.seed if req.seed is not None else "-",
        )

        audio_list = _model.generate(**kwargs)

        if not audio_list or len(audio_list) == 0:
            raise HTTPException(status_code=500, detail="오디오 생성 실패: 빈 결과")

        wav_bytes = _tensor_to_wav(audio_list[0])
        logger.info("TTS 합성 완료: %d bytes, %.1f초", len(wav_bytes), (len(wav_bytes) - 44) / (24000 * 2))

        return Response(content=wav_bytes, media_type="audio/wav")

    except HTTPException:
        raise
    except Exception as e:
        logger.error("TTS 합성 오류: %s", e, exc_info=True)
        raise HTTPException(status_code=500, detail=f"합성 오류: {e}")


def _tensor_to_wav(audio_tensor):
    """텐서 → WAV 바이트 변환 (24kHz, 16-bit PCM)"""
    if audio_tensor.dim() == 2:
        audio_tensor = audio_tensor.squeeze(0)
    audio_np = audio_tensor.detach().cpu().float().numpy()
    audio_np = np.clip(audio_np, -1.0, 1.0)
    audio_int16 = (audio_np * 32767).astype(np.int16)
    buf = io.BytesIO()
    with wave.open(buf, "wb") as wf:
        wf.setnchannels(1)
        wf.setsampwidth(2)
        wf.setframerate(24000)
        wf.writeframes(audio_int16.tobytes())
    return buf.getvalue()


@app.post("/tts-batch")
async def synthesize_batch(req: TTSBatchRequest):
    """여러 텍스트를 한 번에 합성하여 JSON 배열(base64 WAV)로 반환한다."""
    import base64
    import time as _time

    global _model
    if not _model_loaded or _model is None:
        raise HTTPException(status_code=503, detail="모델이 아직 로드되지 않았습니다")

    if not req.texts:
        raise HTTPException(status_code=400, detail="texts가 비어있습니다")

    try:
        kwargs = {
            "text": req.texts,
            "num_step": req.num_step,
            "guidance_scale": req.guidance_scale,
            "t_shift": req.t_shift,
            "class_temperature": req.class_temperature,
            "denoise": req.denoise,
            "audio_chunk_duration": req.audio_chunk_duration,
            "audio_chunk_threshold": req.audio_chunk_threshold,
            "layer_penalty_factor": req.layer_penalty_factor,
            "position_temperature": req.position_temperature,
            "postprocess_output": req.postprocess_output,
        }
        if req.duration is not None:
            kwargs["duration"] = req.duration
        else:
            kwargs["speed"] = req.speed
        if req.language:
            kwargs["language"] = req.language

        resolved_ref = _resolve_ref_audio(req.ref_token, req.ref_audio)
        if resolved_ref and req.ref_text:
            kwargs["ref_audio"] = resolved_ref
            kwargs["ref_text"] = req.ref_text
        elif req.instruct:
            kwargs["instruct"] = req.instruct

        mode = "Voice Clone" if "ref_audio" in kwargs else "Voice Design" if "instruct" in kwargs else "Auto"
        _apply_seed(req.seed)
        logger.info(
            "TTS 배치 합성 시작 [%s]: %d문장, speed=%.1f, num_step=%d, seed=%s",
            mode, len(req.texts), req.speed, req.num_step,
            req.seed if req.seed is not None else "-",
        )

        t0 = _time.time()
        audio_list = _model.generate(**kwargs)
        elapsed = _time.time() - t0

        if not audio_list or len(audio_list) != len(req.texts):
            raise HTTPException(
                status_code=500,
                detail=f"배치 결과 불일치: 요청 {len(req.texts)}개, 응답 {len(audio_list) if audio_list else 0}개",
            )

        results = []
        total_duration = 0.0
        for i, tensor in enumerate(audio_list):
            wav_bytes = _tensor_to_wav(tensor)
            audio_dur = (len(wav_bytes) - 44) / (24000 * 2)
            total_duration += audio_dur
            results.append({
                "index": i,
                "wav_base64": base64.b64encode(wav_bytes).decode("ascii"),
                "audio_duration": round(audio_dur, 2),
                "wav_size": len(wav_bytes),
            })

        rtf = elapsed / total_duration if total_duration > 0 else 0.0
        logger.info(
            "TTS 배치 합성 완료: %d문장, %.1f초 소요, 총 오디오 %.1f초, RTF=%.4f",
            len(req.texts), elapsed, total_duration, rtf,
        )

        return {
            "status": "ok",
            "count": len(results),
            "results": results,
            "elapsed": round(elapsed, 2),
            "total_audio_duration": round(total_duration, 2),
            "rtf": round(rtf, 4),
        }

    except HTTPException:
        raise
    except Exception as e:
        logger.error("TTS 배치 합성 오류: %s", e, exc_info=True)
        raise HTTPException(status_code=500, detail=f"배치 합성 오류: {e}")


class TTSBatchSaveRequest(BaseModel):
    """TTS 배치 합성 + 디스크 직접 저장 요청"""
    texts: list = Field(..., description="합성할 텍스트 목록")
    output_dir: str = Field(..., description="WAV 파일 저장 디렉토리 (절대 경로)")
    filenames: list = Field(..., description="각 텍스트에 대응하는 출력 파일명")
    ref_audio: str = Field(None)
    ref_token: str = Field(None)
    ref_text: str = Field(None)
    instruct: str = Field(None)
    speed: float = Field(1.0)
    num_step: int = Field(32)
    guidance_scale: float = Field(2.0)
    t_shift: float = Field(0.1)
    class_temperature: float = Field(0.0)
    denoise: bool = Field(True)
    audio_chunk_duration: float = Field(15.0)
    audio_chunk_threshold: float = Field(30.0)
    language: str = Field(None)
    duration: float = Field(None)
    layer_penalty_factor: float = Field(5.0)
    position_temperature: float = Field(5.0)
    postprocess_output: bool = Field(True)
    seed: int = Field(None, description="시드 (배치 전체 공유)")


@app.post("/tts-batch-save")
async def synthesize_batch_save(req: TTSBatchSaveRequest):
    """여러 텍스트를 합성하여 지정된 디렉토리에 WAV 파일로 직접 저장한다."""
    import time as _time

    global _model
    if not _model_loaded or _model is None:
        raise HTTPException(status_code=503, detail="모델이 아직 로드되지 않았습니다")

    if not req.texts:
        raise HTTPException(status_code=400, detail="texts가 비어있습니다")
    if len(req.texts) != len(req.filenames):
        raise HTTPException(status_code=400, detail="texts와 filenames 길이가 다릅니다")

    try:
        os.makedirs(req.output_dir, exist_ok=True)

        kwargs = {
            "text": req.texts,
            "num_step": req.num_step,
            "guidance_scale": req.guidance_scale,
            "t_shift": req.t_shift,
            "class_temperature": req.class_temperature,
            "denoise": req.denoise,
            "audio_chunk_duration": req.audio_chunk_duration,
            "audio_chunk_threshold": req.audio_chunk_threshold,
            "layer_penalty_factor": req.layer_penalty_factor,
            "position_temperature": req.position_temperature,
            "postprocess_output": req.postprocess_output,
        }
        if req.duration is not None:
            kwargs["duration"] = req.duration
        else:
            kwargs["speed"] = req.speed
        if req.language:
            kwargs["language"] = req.language

        resolved_ref = _resolve_ref_audio(req.ref_token, req.ref_audio)
        if resolved_ref and req.ref_text:
            kwargs["ref_audio"] = resolved_ref
            kwargs["ref_text"] = req.ref_text
        elif req.instruct:
            kwargs["instruct"] = req.instruct

        mode = "Voice Clone" if "ref_audio" in kwargs else "Voice Design" if "instruct" in kwargs else "Auto"
        _apply_seed(req.seed)
        logger.info(
            "TTS 배치→디스크 저장 시작 [%s]: %d문장, dir=%s, seed=%s",
            mode, len(req.texts), req.output_dir,
            req.seed if req.seed is not None else "-",
        )

        t0 = _time.time()
        audio_list = _model.generate(**kwargs)
        gpu_elapsed = _time.time() - t0

        if not audio_list or len(audio_list) != len(req.texts):
            raise HTTPException(
                status_code=500,
                detail=f"배치 결과 불일치: 요청 {len(req.texts)}개, 응답 {len(audio_list) if audio_list else 0}개",
            )

        results = []
        total_duration = 0.0
        for i, tensor in enumerate(audio_list):
            wav_bytes = _tensor_to_wav(tensor)
            audio_dur = (len(wav_bytes) - 44) / (24000 * 2)
            total_duration += audio_dur

            filepath = os.path.join(req.output_dir, req.filenames[i])
            with open(filepath, "wb") as f:
                f.write(wav_bytes)

            results.append({
                "index": i,
                "filename": req.filenames[i],
                "audio_duration": round(audio_dur, 2),
                "wav_size": len(wav_bytes),
            })

        total_elapsed = _time.time() - t0
        rtf = gpu_elapsed / total_duration if total_duration > 0 else 0.0
        logger.info(
            "TTS 배치→디스크 저장 완료: %d문장, GPU %.1f초 + 저장 %.1f초, 총 오디오 %.1f초, RTF=%.4f",
            len(req.texts), gpu_elapsed, total_elapsed - gpu_elapsed, total_duration, rtf,
        )

        return {
            "status": "ok",
            "count": len(results),
            "results": results,
            "gpu_elapsed": round(gpu_elapsed, 2),
            "total_elapsed": round(total_elapsed, 2),
            "total_audio_duration": round(total_duration, 2),
            "rtf": round(rtf, 4),
        }

    except HTTPException:
        raise
    except Exception as e:
        logger.error("TTS 배치→디스크 저장 오류: %s", e, exc_info=True)
        raise HTTPException(status_code=500, detail=f"배치 합성 오류: {e}")


# ── ASR ──────────────────────────────────────────────

@app.get("/asr/status")
async def asr_status():
    return {"loaded": _asr_loaded}


@app.post("/asr")
async def transcribe(req: ASRRequest):
    """음성 파일의 텍스트를 자동 추출한다."""
    global _asr_loaded

    if not _model_loaded or _model is None:
        raise HTTPException(status_code=503, detail="TTS 모델이 아직 로드되지 않았습니다")

    if not os.path.exists(req.audio_path):
        raise HTTPException(status_code=400, detail=f"음성 파일을 찾을 수 없습니다: {req.audio_path}")

    try:
        if not _asr_loaded:
            logger.info("ASR 모델 로드 시작 (whisper-large-v3-turbo)...")
            _model.load_asr_model("openai/whisper-large-v3-turbo")
            _asr_loaded = True
            logger.info("ASR 모델 로드 완료")

        logger.info("ASR 시작: %s", req.audio_path)
        text = _model.transcribe(req.audio_path)
        logger.info("ASR 완료: %s → '%s'", req.audio_path, text[:100])

        return {"text": text}

    except Exception as e:
        logger.error("ASR 오류: %s", e, exc_info=True)
        raise HTTPException(status_code=500, detail=f"ASR 오류: {e}")


# ── 서버 시작 ───────────────────────────────────────

def load_model(gpu="cuda:0"):
    global _model, _model_loaded

    logger.info("OmniVoice 모델 로드 시작 (device=%s)...", gpu)
    try:
        from omnivoice import OmniVoice

        _model = OmniVoice.from_pretrained(
            "k2-fsa/OmniVoice",
            device_map=gpu,
            dtype=torch.float16,
        )
        _model_loaded = True
        logger.info("OmniVoice 모델 로드 완료")
    except Exception as e:
        logger.error("OmniVoice 모델 로드 실패: %s", e, exc_info=True)
        raise


def _background_load_model(gpu="cuda:0"):
    try:
        load_model(gpu)
    except Exception as e:
        logger.error("백그라운드 모델 로드 실패: %s (서버는 계속 실행, /health는 503 반환)", e)


def main():
    parser = argparse.ArgumentParser(description="OmniVoice API 서버")
    parser.add_argument("-a", "--address", default="0.0.0.0", help="바인드 주소")
    parser.add_argument("-p", "--port", type=int, default=9881, help="포트 번호")
    parser.add_argument("--gpu", default="cuda:0", help="GPU 디바이스 (예: cuda:0)")
    args = parser.parse_args()

    import threading
    model_thread = threading.Thread(target=_background_load_model, args=(args.gpu,), daemon=True)
    model_thread.start()

    uvicorn.run(app, host=args.address, port=args.port, log_level="info")


if __name__ == "__main__":
    main()
