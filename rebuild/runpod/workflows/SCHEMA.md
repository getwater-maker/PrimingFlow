# ComfyUI 워크플로 JSON ↔ PrimingFlow 인터페이스 명세

이 문서는 `runpod-comfy-provider.js` 가 워크플로 JSON 의 어떤 슬롯에 사용자 입력을 주입하는지 규정합니다. 모든 워크플로 JSON 은 이 명세를 따라야 합니다.

## ComfyUI 워크플로 두 가지 형식 — 우리는 API 형식 사용

| 형식 | 용도 | 우리 쓰는 곳 |
|---|---|---|
| **UI Workflow** (`workflow.json`) | ComfyUI 비주얼 에디터가 저장. nodes/links/position 메타데이터 포함 | ❌ |
| **API Workflow** (`workflow_api.json`) | 노드 ID 기반 dict. 프로그래밍 호출용 | ✅ **이걸 사용** |

ComfyUI 웹 UI 에서 워크플로 export 시 **"Save (API Format)"** 을 선택해야 합니다.

## PrimingFlow 가 주입하는 슬롯 (필수)

워크플로 JSON 옆에 같은 이름의 매니페스트 파일을 둡니다:

```
workflows/
├── qwen-image-korean-history.json         ← API workflow
├── qwen-image-korean-history.manifest.json  ← 슬롯 위치 명세
```

매니페스트 구조:

```json
{
  "name": "qwen-image-korean-history",
  "displayName": "Qwen-Image (한국 역사)",
  "modelType": "image",
  "baseModel": "Qwen-Image",
  "license": "Apache-2.0",
  "supports": {
    "refImage": false,
    "loras": false,
    "negativePrompt": true
  },
  "slots": {
    "prompt":         { "nodeId": "6",  "inputKey": "text" },
    "negativePrompt": { "nodeId": "7",  "inputKey": "text", "default": "blurry, low quality, watermark, text" },
    "seed":           { "nodeId": "3",  "inputKey": "seed" },
    "steps":          { "nodeId": "3",  "inputKey": "steps", "default": 25 },
    "cfg":            { "nodeId": "3",  "inputKey": "cfg", "default": 4.0 },
    "width":          { "nodeId": "5",  "inputKey": "width" },
    "height":         { "nodeId": "5",  "inputKey": "height" }
  },
  "output": {
    "nodeId": "9",
    "type": "image"
  },
  "comfyExtensions": [
    "ComfyUI-Manager"
  ],
  "models": [
    {
      "type": "checkpoint",
      "repo": "Qwen/Qwen-Image",
      "filename": "qwen-image.safetensors",
      "sizeGB": 20
    }
  ]
}
```

### 슬롯 의미

| 슬롯 | 의미 | 예시 노드 |
|---|---|---|
| `prompt` | 사용자 prompt 텍스트가 주입됨 | `CLIPTextEncode` 의 text |
| `negativePrompt` | 부정 프롬프트 | 두 번째 `CLIPTextEncode` |
| `seed` | 랜덤 시드 (-1 이면 PrimingFlow 가 랜덤 생성 후 주입) | `KSampler` 의 seed |
| `steps`, `cfg` | 샘플링 파라미터 | `KSampler` |
| `width`, `height` | 출력 해상도 | `EmptyLatentImage` |
| `refImage` (옵션) | 캐릭터 참조 이미지 base64 → `LoadImage` 노드 | `IPAdapterAdvanced` 와 연결된 `LoadImage` |
| `motionPrompt` (i2v) | 움직임 묘사 텍스트 | `WanVideo` 워크플로의 motion prompt 노드 |
| `inputImage` (i2v) | i2v 입력 이미지 base64 → `LoadImage` | Wan2.2 의 시작 프레임 |

### LoRA 슬롯 (SDXL 워크플로 한정)

```json
"loras": [
  { "nodeId": "12", "inputKey": "lora_name", "strengthKey": "strength_model" },
  { "nodeId": "13", "inputKey": "lora_name", "strengthKey": "strength_model" },
  { "nodeId": "14", "inputKey": "lora_name", "strengthKey": "strength_model" }
]
```

`LoraLoader` 노드를 N개 체인 연결. PrimingFlow 가 UI 에서 선택된 LoRA 파일명 + 강도를 슬롯 순서대로 주입.

## RunPod API 호출 흐름

`rebuild/image/providers/runpod-comfy-provider.js` 의 의사 코드:

```javascript
async function synth({ prompt, refImagePath, workflowName, seed, width, height, outputPath }) {
    // 1. 워크플로 JSON + 매니페스트 로드
    const workflow = require(`../../runpod/workflows/${workflowName}.json`);
    const manifest = require(`../../runpod/workflows/${workflowName}.manifest.json`);

    // 2. 깊은 복사 후 슬롯 주입
    const wf = JSON.parse(JSON.stringify(workflow));
    inject(wf, manifest.slots.prompt, prompt);
    if (seed === -1) seed = Math.floor(Math.random() * 1e9);
    inject(wf, manifest.slots.seed, seed);
    inject(wf, manifest.slots.width, width);
    inject(wf, manifest.slots.height, height);

    // 3. 참조 이미지가 있고 워크플로가 지원하면 base64 로 첨부
    const images = [];
    if (refImagePath && manifest.supports.refImage) {
        images.push({
            name: 'ref_image.png',
            image: fs.readFileSync(refImagePath).toString('base64')
        });
    }

    // 4. RunPod 호출
    const endpointUrl = await PodController.ensureRunning();
    const resp = await fetch(`${endpointUrl}/runsync`, {
        method: 'POST',
        headers: { 'Authorization': `Bearer ${apiKey}` },
        body: JSON.stringify({ input: { workflow: wf, images } })
    });

    // 5. base64 결과를 outputPath 에 저장
    const result = await resp.json();
    const b64 = result.output.images[0].data;
    fs.writeFileSync(outputPath, Buffer.from(b64, 'base64'));
    return { path: outputPath, width, height };
}

function inject(wf, slot, value) {
    wf[slot.nodeId].inputs[slot.inputKey] = value;
}
```

## 워크플로 JSON 의 검증/교체 흐름

repo 에는 **placeholder** 또는 **공식 example 기반 초안** 이 commit 되어 있습니다. 실제 작동 검증은 다음 절차:

1. RunPod Pod 띄움 (`SETUP_GUIDE.md` 참고) → ComfyUI 웹 UI 접속 (https://{POD_ID}-8188.proxy.runpod.net)
2. 공식 example 워크플로 로드 또는 placeholder 노드 그래프 재현
3. ComfyUI 우측 메뉴 → `Save (API Format)` → 다운로드
4. 다운로드된 JSON 을 PrimingFlow 의 `workflows/{name}.json` 으로 교체
5. 같은 위치의 `.manifest.json` 의 `slots` 노드 ID 가 새 JSON 의 노드 ID 와 일치하는지 확인
6. PrimingFlow 에서 "이미지 생성 테스트" 버튼 → 1장 정상 생성되면 commit

## 공식 example 워크플로 출처

| 모델 | 출처 |
|---|---|
| Qwen-Image | https://github.com/comfyanonymous/ComfyUI_examples/tree/master/qwen_image |
| SDXL + IP-Adapter | https://github.com/cubiq/ComfyUI_IPAdapter_plus#examples |
| Wan2.2-I2V | https://github.com/kijai/ComfyUI-WanVideoWrapper (공식 example 다수) |

처음 띄울 때는 이 example 들을 그대로 시작점으로 사용하고, 검증 후 한국 역사 컨텍스트에 맞게 negative prompt·LoRA 만 조정합니다.

## 응답 형식 (RunPod worker-comfyui)

```json
{
  "id": "abc123",
  "status": "COMPLETED",
  "output": {
    "images": [
      {
        "filename": "ComfyUI_00001_.png",
        "data": "<base64 PNG data>"
      }
    ]
  }
}
```

비디오는 `images` 대신 `videos` 키를 사용하는 worker 도 있고 같은 키를 쓰는 worker 도 있습니다. 매니페스트의 `output.type` 에 `"image"` 또는 `"video"` 명시.
