#!/usr/bin/env bash
# PrimingFlow ComfyUI Pod 시작 스크립트
set -e

echo "==========================================="
echo "PrimingFlow ComfyUI Pod 부팅"
echo "  HF_HOME = $HF_HOME"
echo "  GPU =     $(nvidia-smi --query-gpu=name --format=csv,noheader 2>/dev/null || echo 'unknown')"
echo "==========================================="

mkdir -p "$HF_HOME" "$TORCH_HOME"

# 1) 모델 다운로드 (캐시 히트 시 즉시 진행)
echo ""
echo "[1/2] 모델 다운로드 확인..."
cd /workspace
if ! python /workspace/download-models.py; then
    echo "❌ 모델 다운로드 실패 — ComfyUI 시동 중단"
    exit 1
fi

# 2) ComfyUI 시동
echo ""
echo "[2/2] ComfyUI 시동 (port 8188, listen 0.0.0.0)..."
cd /workspace/ComfyUI

# RunPod 의 proxy 가 8188 로 접근하므로 listen 0.0.0.0 필수.
# --enable-cors-header 는 PrimingFlow 가 다른 도메인에서 호출하므로 필요.
exec python main.py \
    --listen 0.0.0.0 \
    --port 8188 \
    --enable-cors-header \
    --preview-method none
