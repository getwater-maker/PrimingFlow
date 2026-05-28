# LoRA 보관함

Civitai 등에서 다운로드한 한국 역사 LoRA 의 `.safetensors` 파일을 이 폴더에 떨어뜨립니다.

## 권장 LoRA 목록 (Civitai 검색 키워드)

| 키워드 | 효과 | 강도 권장 |
|---|---|---|
| `joseon hanbok` | 조선시대 한복 정확도 | 0.7~0.9 |
| `goryeo style` | 고려·삼국시대 의복 | 0.6~0.8 |
| `korean palace` / `hanok` | 경복궁·창덕궁·한옥 건축 | 0.5~0.7 |
| `korean historical drama` | 사극풍 화면톤·조명 | 0.3~0.5 |
| `joseon royal court` | 왕·왕비·신료 복식 | 0.7~0.9 |

## 파일 명명 규칙

```
loras/
├── joseon-hanbok-v2.safetensors
├── korean-palace-v1.safetensors
├── kdrama-lighting.safetensors
└── manifest.json   ← UI 가 자동 생성 (LoRA 표시명·기본강도·태그)
```

`manifest.json` 은 PrimingFlow UI 가 자동 생성·갱신합니다. 사용자가 직접 편집할 필요 없음.

## Docker 이미지에 포함 vs Pod 마운트

- **포함 (기본)**: `docker/Dockerfile` 빌드 시 이 폴더 통째로 COPY → 가장 단순, Pod 부팅 즉시 사용 가능
- **마운트 (확장)**: 큰 LoRA 가 많아지면 별도 RunPod Volume 에 두고 마운트 (월 $0.7/10GB 비용 발생)

처음에는 포함 방식으로 시작 → LoRA 가 5GB 넘어가면 마운트로 전환 고려.

## 라이선스 주의

Civitai LoRA 는 각각 라이선스가 다릅니다. 상업 사용 가능한 것만 다운로드:
- ✅ `CreativeML OpenRAIL-M` — 상업 OK
- ✅ `Apache 2.0` — 상업 OK
- ⚠️ `Non-Commercial` — YouTube 수익화에 사용 불가
- ⚠️ Custom 라이선스 — 페이지의 "License" 섹션 확인 필수
