# PrimingFlow ComfyUI Pod Image
#
# Base: nvidia/cuda CUDA 12.4 + cuDNN runtime (ComfyUI/Wan2.2 호환)
# Python 3.11 + ComfyUI + 필수 custom_nodes 미리 설치
# 모델은 첫 부팅 시 download-models.py 가 HF 에서 받음 (영상 권장 방식: HF cache)
#
# 빌드:
#   docker build -t YOUR_DOCKERHUB_USER/primingflow-comfyui:1.0 .
#   docker push YOUR_DOCKERHUB_USER/primingflow-comfyui:1.0
#
# RunPod 에서 이 이미지 주소를 Template Container Image 필드에 입력.

FROM nvidia/cuda:12.4.1-cudnn-runtime-ubuntu22.04

ENV DEBIAN_FRONTEND=noninteractive \
    PYTHONUNBUFFERED=1 \
    HF_HOME=/workspace/hf-cache \
    TORCH_HOME=/workspace/torch-cache \
    PIP_ROOT_USER_ACTION=ignore

# 시스템 의존성
RUN apt-get update && apt-get install -y --no-install-recommends \
        python3.11 python3.11-dev python3.11-venv python3-pip \
        git wget curl ca-certificates \
        ffmpeg libgl1 libglib2.0-0 libsm6 libxext6 libxrender1 \
    && rm -rf /var/lib/apt/lists/* \
    && ln -sf /usr/bin/python3.11 /usr/bin/python \
    && ln -sf /usr/bin/python3.11 /usr/bin/python3 \
    && python -m pip install --no-cache-dir --upgrade pip

WORKDIR /workspace

# ComfyUI (특정 tag 고정 권장 — 무모한 main 추적 X)
ARG COMFY_REF=master
RUN git clone https://github.com/comfyanonymous/ComfyUI.git /workspace/ComfyUI \
    && cd /workspace/ComfyUI && git checkout ${COMFY_REF}

# PyTorch — CUDA 12.4 빌드
RUN pip install --no-cache-dir \
        torch==2.4.1+cu124 torchvision==0.19.1+cu124 torchaudio==2.4.1+cu124 \
        --index-url https://download.pytorch.org/whl/cu124

# ComfyUI 기본 requirements
RUN pip install --no-cache-dir -r /workspace/ComfyUI/requirements.txt

# Custom Nodes — PrimingFlow 워크플로가 의존하는 것만
WORKDIR /workspace/ComfyUI/custom_nodes
RUN git clone --depth 1 https://github.com/ltdrdata/ComfyUI-Manager.git              ComfyUI-Manager \
    && git clone --depth 1 https://github.com/cubiq/ComfyUI_IPAdapter_plus.git       ComfyUI_IPAdapter_plus \
    && git clone --depth 1 https://github.com/kijai/ComfyUI-WanVideoWrapper.git      ComfyUI-WanVideoWrapper \
    && git clone --depth 1 https://github.com/Kosinkadink/ComfyUI-VideoHelperSuite.git ComfyUI-VideoHelperSuite

# Custom Node 의 추가 requirements 일괄 설치
RUN for d in /workspace/ComfyUI/custom_nodes/*/; do \
        if [ -f "$d/requirements.txt" ]; then \
            echo "[deps] $d"; \
            pip install --no-cache-dir -r "$d/requirements.txt" || echo "[warn] $d requirements failed (계속)"; \
        fi; \
    done

# 추가 가속 라이브러리 (Wan 2.2 의 sageattn 모드용)
RUN pip install --no-cache-dir \
        huggingface_hub[cli]==0.27.0 \
        sageattention \
        || echo "[warn] optional accel libs failed (계속)"

# PrimingFlow 자산 복사
WORKDIR /workspace
COPY workflows/                   /workspace/workflows/
COPY docker/extra_model_paths.yaml /workspace/ComfyUI/extra_model_paths.yaml
COPY docker/download-models.py    /workspace/download-models.py
COPY docker/start.sh              /workspace/start.sh

# LoRA 파일들 (.gitkeep + 사용자가 추가한 .safetensors) 그대로 복사
COPY loras/                       /workspace/ComfyUI/models/loras/

RUN chmod +x /workspace/start.sh

# 모델 캐시 디렉토리는 빈 상태로 생성 — 첫 부팅 시 download-models.py 가 채움
RUN mkdir -p /workspace/hf-cache /workspace/torch-cache

EXPOSE 8188

CMD ["bash", "/workspace/start.sh"]
