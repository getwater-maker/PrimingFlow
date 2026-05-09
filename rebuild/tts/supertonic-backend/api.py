"""
Supertonic-3 FastAPI 래퍼 서버
- supertonic 라이브러리(CPU ONNX, ~99M)를 HTTP API 로 노출
- 포트 9882 (OmniVoice 9881 과 분리)
- pre-defined voice (M1/F1/M2/F2 ...) 만 지원 — Voice Clone 미지원
- 31 언어 지원 (한국어 포함)

엔드포인트:
  GET  /health     → {"status": "ok"} (모델 로드 후) / 503
  GET  /voices     → {"voices": ["M1", "F1", ...]}
  GET  /languages  → {"codes": ["ko", "en", ...]}
  POST /tts        → WAV 바이트 (audio/wav)
"""

import argparse
import io
import logging
import os
import sys
import wave
from typing import Optional

import numpy as np
import uvicorn
from fastapi import FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import Response, JSONResponse
from pydantic import BaseModel, Field

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s [%(levelname)s] %(message)s",
)
logger = logging.getLogger("supertonic-api")


class _HealthFilter(logging.Filter):
    def filter(self, record):
        return "/health" not in record.getMessage()


logging.getLogger("uvicorn.access").addFilter(_HealthFilter())

app = FastAPI(title="Supertonic-3 API", version="1.0.0")

# Electron renderer(file://) 대비 CORS
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_methods=["GET", "POST", "OPTIONS"],
    allow_headers=["Content-Type", "X-API-Key"],
)

# ── 간단한 API 키 인증 (OmniVoice 와 동일 패턴) ─────────────
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
        return JSONResponse(
            status_code=401,
            content={"error": "Unauthorized — X-API-Key header required"},
        )
    return await call_next(request)


if _API_KEY:
    logger.info("API 키 인증 활성화 (X-API-Key 헤더 필요, /health 제외)")
else:
    logger.info("API 키 인증 비활성화 — 신뢰 LAN/단독 사용 모드")


# ── 모델 전역 ──────────────────────────────────────────────
_tts = None
_model_loaded = False
_voice_names: list = []
_languages: list = []


# ── 요청 스키마 ────────────────────────────────────────────
class TTSRequest(BaseModel):
    text: str
    voice_id: str = Field("M1", description="pre-defined voice (예: M1, F1, M2, F2)")
    lang: str = Field("ko", description="ISO 언어 코드 (ko/en/ja/...)")
    speed: float = Field(1.0, ge=0.25, le=4.0)
    silence_duration: float = Field(0.5, ge=0.0, le=2.0, description="문장 사이 무음(초)")
    total_steps: Optional[int] = Field(None, description="None 이면 라이브러리 기본값")


# ── 헬스체크 / 메타 ────────────────────────────────────────
@app.get("/health")
def health():
    if not _model_loaded:
        return JSONResponse(status_code=503, content={"status": "loading"})
    return {"status": "ok", "model_loaded": True, "voices": len(_voice_names), "languages": len(_languages)}


@app.get("/voices")
def voices():
    return {"voices": _voice_names}


@app.get("/languages")
def languages():
    return {"codes": _languages}


# ── 합성 ───────────────────────────────────────────────────
def _wav_bytes_from_ndarray(wav: np.ndarray, sample_rate: int) -> bytes:
    """supertonic synthesize 가 반환한 (1, N) float32 numpy → 16-bit PCM WAV bytes."""
    if wav is None:
        raise ValueError("wav is None")
    arr = np.asarray(wav)
    if arr.ndim == 2:
        # (1, N) 또는 (channels, N) — 첫 채널만 사용
        arr = arr[0] if arr.shape[0] < arr.shape[1] else arr.flatten()
    arr = arr.astype(np.float32, copy=False)
    arr = np.clip(arr, -1.0, 1.0)
    pcm = (arr * 32767.0).astype(np.int16)

    buf = io.BytesIO()
    with wave.open(buf, "wb") as wf:
        wf.setnchannels(1)
        wf.setsampwidth(2)
        wf.setframerate(int(sample_rate))
        wf.writeframes(pcm.tobytes())
    return buf.getvalue()


@app.post("/tts")
def synthesize(req: TTSRequest):
    if not _model_loaded or _tts is None:
        raise HTTPException(status_code=503, detail="모델이 아직 로드되지 않았습니다")

    text = (req.text or "").strip()
    if not text:
        raise HTTPException(status_code=400, detail="text 가 비어있습니다")

    try:
        style = _tts.get_voice_style(voice_name=req.voice_id)
    except Exception as e:
        raise HTTPException(status_code=400, detail=f"voice_id '{req.voice_id}' 인식 실패: {e}")

    kwargs = dict(
        text=text,
        voice_style=style,
        speed=req.speed,
        silence_duration=req.silence_duration,
        lang=req.lang,
    )
    if req.total_steps is not None:
        kwargs["total_steps"] = int(req.total_steps)

    try:
        wav, _duration = _tts.synthesize(**kwargs)
    except Exception as e:
        logger.error("TTS 합성 오류: %s", e, exc_info=True)
        raise HTTPException(status_code=500, detail=f"합성 오류: {e}")

    sr = getattr(_tts, "sample_rate", 24000)
    wav_bytes = _wav_bytes_from_ndarray(wav, sr)
    return Response(content=wav_bytes, media_type="audio/wav")


# ── 모델 로딩 ──────────────────────────────────────────────
def _load_model():
    global _tts, _model_loaded, _voice_names, _languages
    logger.info("Supertonic-3 모델 로드 중... (auto_download=True, 첫 실행 시 ~99M 다운로드)")
    try:
        from supertonic import TTS, AVAILABLE_LANGUAGES
        _tts = TTS(auto_download=True)
        _voice_names = list(getattr(_tts, "voice_style_names", []) or ["M1"])
        _languages = sorted(list(AVAILABLE_LANGUAGES))
        _model_loaded = True
        logger.info("모델 로드 완료 — voices=%s, langs=%d, sample_rate=%s",
                    _voice_names, len(_languages), getattr(_tts, "sample_rate", "?"))
    except Exception as e:
        logger.error("모델 로드 실패: %s", e, exc_info=True)
        # 부분 로드 상태로 계속 — /health 가 503 반환하여 클라이언트가 알게 됨
        _model_loaded = False


@app.on_event("startup")
def _on_startup():
    _load_model()


# ── 단독 실행 (python api.py) ──────────────────────────────
if __name__ == "__main__":
    parser = argparse.ArgumentParser(description="Supertonic-3 FastAPI server")
    parser.add_argument("--host", default="0.0.0.0")
    parser.add_argument("--port", type=int, default=int(os.environ.get("FLOW_SUPERTONIC_PORT", "9882")))
    args = parser.parse_args()

    logger.info("Supertonic-3 API 서버 시동 (host=%s, port=%d)", args.host, args.port)
    uvicorn.run(app, host=args.host, port=args.port, log_level="info")
