# PrimingFlow 이미지 스타일 가이드

> 자동 생성 — 2026-05-19
> 데이터 출처: `core/style-store.js` (빌트인 시드) + `~/.flow-app/styles.json` (사용자 추가) + `~/.flow-app/style-order.json` (사용자 표시 순서)

## 한눈에 보기

- **빌트인 스타일**: 27종 (수정/삭제 불가, 코드 시드)
- **사용자 추가 스타일**: 0종 (아직 추가한 항목 없음)
- **저장 위치**: `~/.flow-app/styles.json`
- **표시 순서**: `~/.flow-app/style-order.json` 에 따라 사용자가 드래그앤드롭으로 재정렬 가능

## 프롬프트 적용 흐름

1단계에서 사용자가 채널/프리셋의 스타일을 선택하면, 본문 한 문단마다 다음 형태의 영문 프롬프트가 자동 조립되어 Google Flow 로 전송됩니다 (`flow-engine.js:2893-2897`):

```
{스타일 프롬프트}, {비율} aspect ratio, scene: {영문 번역된 문단}, setting: {프리셋 영문}, highly detailed, no text, no watermark
```

| 조각 | 출처 | 비고 |
|---|---|---|
| `{스타일 프롬프트}` | 아래 27종 중 사용자가 선택한 항목 | 못 찾으면 `cinematic` 으로 자동 폴백 |
| `{비율} aspect ratio` | 현재 영상 비율 정책에 따라 결정 | 롱폼=`16:9`, 숏폼=`9:16` |
| `scene: {...}` | 본문 한 문단 → Gemini 가 영문 번역 | 번역 실패 시 원문 사용 |
| `setting: {...}` | 프리셋의 `presetPrompt` 영문 번역 | 비어있으면 생략 |
| `highly detailed, no text, no watermark` | 고정 공통 키워드 | 모든 컷에 자동 부착 |

별도로 **스타일 관리 모달의 📋 복사 버튼**은 "공통 추가 키워드" 입력란에 사용자가 적어둔 값을 스타일 프롬프트 뒤에 붙여 클립보드로 복사합니다 (수동 외부 도구용 — 자동 생성 흐름엔 영향 없음).

---

## 빌트인 스타일 27종 (분류별)

### 🎨 웹툰·만화·애니메이션 계열

#### 한국 웹툰 (`k-webtoon`)
```
beautiful Korean webtoon style, manhwa art, soft shading, detailed characters, emotional expressions, Korean comic illustration, clean lineart, pastel colors
```

#### 웹툰 일러스트 (`webtoon-illust`)
```
webtoon illustration style, digital painting, semi-realistic, vivid colors, detailed background, Korean manhwa inspired, clean composition
```

#### 애니메이션 (`anime`)
```
anime style illustration, vibrant colors, expressive characters, Japanese animation
```

#### 만화/코믹 (`comic`)
```
comic book style, bold outlines, dynamic composition, vivid colors, action panels
```

#### 치비 (귀여운) (`chibi`)
```
chibi anime style, cute super-deformed characters, big eyes, small body, kawaii, pastel colors
```

#### 치비 (성경시대) (`biblical-chibi`)
```
chibi anime style, cute super-deformed characters with big sparkling eyes and small bodies, kawaii, soft pastel earth tones (ochre, sand, olive, terracotta), ancient biblical era setting, characters wearing flowing robes and tunics, simple head coverings, leather sandals, bearded elders, Holy Land scenery with olive trees and stone buildings, gentle reverent atmosphere, hand-drawn anime illustration, NOT modern clothing, NOT Korean historical drama, NOT photorealistic
```

#### 지브리 (미야자키) (`ghibli`)
```
Studio Ghibli anime style, soft watercolor backgrounds, warm lighting, detailed nature, Hayao Miyazaki inspired
```

#### 디즈니/픽사 (`disney`)
```
Disney 3D animation style, Pixar-like rendering, expressive characters, vibrant colors, family friendly
```

---

### 📸 사실·시네마틱 계열

#### 시네마틱 (영화풍) (`cinematic`)
```
cinematic film still, dramatic lighting, movie scene
```
※ 스타일 ID 를 찾지 못했을 때의 자동 폴백 스타일.

#### 포토리얼 (실사) (`photorealistic`)
```
photorealistic photography, high detail, natural lighting, 8K
```

#### 3D 렌더링 (`3d`)
```
3D rendered scene, ray tracing, realistic materials, cinematic lighting, Unreal Engine
```

#### 필름 누아르 (`noir`)
```
film noir, black and white, high contrast, shadows, dramatic mood, vintage
```

#### 모노크롬 (`monochrome`)
```
monochrome digital painting, smooth grayscale shading, black and white, strong contrast, dramatic cinematic lighting, realistic idealized llustration, detailed rendering, 4K
```

---

### 🖌️ 회화·전통 미술 계열

#### 수채화 (`watercolor`)
```
traditional watercolor painting, aquarelle, wet-on-wet technique, visible paper texture, soft pastel color washes, flowing translucent pigments, hand-painted on cotton paper, loose brush strokes, bleeding colors, artistic fine art, NOT digital illustration, NOT line art, NOT webtoon, NOT manhwa, NOT anime
```

#### 수채화 (성경시대) (`biblical-watercolor`)
```
traditional watercolor painting of ancient biblical era, aquarelle, wet-on-wet technique, visible paper texture, soft earth-tone washes (ochre, sand, olive, terracotta), flowing translucent pigments, hand-painted on cotton paper, loose brush strokes, ancient Middle Eastern setting, biblical figures in flowing robes and tunics, head coverings, sandals, bearded elders, Holy Land landscape with olive trees and stone buildings, reverent atmosphere, sacred scripture illustration, fine art, NOT digital illustration, NOT line art, NOT webtoon, NOT manhwa, NOT anime, NOT modern clothing, NOT Korean historical drama
```

#### 수묵화 (`ink`)
```
ink wash painting, traditional, minimalist, elegant brush strokes
```

#### 유화 (`oil`)
```
oil painting, classical, rich colors, elegant brushwork, fine art
```

#### 연필 스케치 (`sketch`)
```
pencil sketch drawing, graphite on paper, detailed cross-hatching, artistic hand-drawn
```

#### 일러스트 (`illustration`)
```
digital illustration, clean lines, warm colors, detailed
```

---

### 🎮 게임·픽셀 계열

#### 픽셀 아트 (`pixel`)
```
pixel art, retro game style, 16-bit, vibrant colors, detailed sprites
```

#### 마인크래프트 (`minecraft`)
```
Minecraft game screenshot, voxel art, blocky 3D world, cubic characters, pixel textures, in-game capture
```

---

### 🌈 디자인·스타일라이즈 계열

#### 판타지 아트 (`fantasy`)
```
fantasy art, epic scene, magical atmosphere, detailed environment, concept art
```

#### 레트로 80s (`retro`)
```
retro 80s synthwave, neon colors, grid landscape, sunset, VHS aesthetic, vaporwave
```

#### 팝아트 (`pop`)
```
pop art style, Roy Lichtenstein, bold colors, halftone dots, comic book aesthetic, Andy Warhol inspired
```

#### 졸라맨 (스틱맨) (`stickman`)
```
simple stick figure drawing, black lines on white background, minimalist doodle, hand-drawn sketch style, funny stick characters
```

---

### 📊 인포그래픽 계열 (한국어 프롬프트)

#### 인포그래픽 3D (`infographic-3d`)
```
아래 내용의 대표이미지 한컷을 3D인포그래픽 작성, 한글로 작성, 어른들이 보기 편하게 작성
```

#### 인포그래픽 2D (`infographic-2d`)
```
아래 내용의 대표이미지 한컷을 2D인포그래픽 작성, 한글로 작성, 어른들이 보기 편하게 작성
```

> ⚠ 이 두 스타일은 한국어 프롬프트라 다른 스타일과 결합 방식이 다릅니다. 본문 영문 번역과 한국어 지시가 혼재되니 결과 품질 확인 후 사용 권장.

---

## 현재 표시 순서 (style-order.json)

1. 한국 웹툰
2. 웹툰 일러스트
3. 모노크롬
4. 시네마틱 (영화풍)
5. 포토리얼 (실사)
6. 일러스트
7. 애니메이션
8. 수채화
9. 수채화 (성경시대)
10. 수묵화
11. 유화
12. 판타지 아트
13. 필름 누아르
14. 픽셀 아트
15. 만화/코믹
16. 디즈니/픽사
17. 3D 렌더링
18. 마인크래프트
19. 졸라맨 (스틱맨)
20. ~~심슨 (simpsons)~~ — order 파일에는 있으나 빌트인 정의에는 없는 잔재 ID. 실제 표시 안 됨
21. 지브리 (미야자키)
22. 치비 (귀여운)
23. 레트로 80s
24. 연필 스케치
25. 팝아트

순서 파일에 명시 안 된 항목은 뒤쪽에 자동 추가됩니다 (현재: 치비-성경시대, 인포그래픽 3D, 인포그래픽 2D).

---

## 정책 요약

| 항목 | 정책 |
|---|---|
| 빌트인 27종 | 수정·삭제 불가 (코드 시드) |
| 빌트인 사본 만들기 | 🔧 수정 버튼 → 자동으로 `복사본` 생성 후 편집 (원본 보존) |
| 사용자 추가 | ➕ 새 스타일 — name + prompt 만 입력 |
| 순서 변경 | ⋮⋮ 핸들 드래그 — 빌트인/사용자 무관하게 자유 정렬 |
| 폴백 | 스타일 ID 못 찾으면 `cinematic` |
| 외부 편집 | `~/.flow-app/styles.json` 직접 편집 가능 — 재시작 후 반영 |

---

## 참고 파일 경로

- 빌트인 시드 정의: `rebuild/core/style-store.js:20-48` (`BUILT_IN_STYLES` 배열)
- 적용 코드: `rebuild/flow-engine.js:299-303` (스타일 조회 + 폴백)
- 최종 프롬프트 조립: `rebuild/flow-engine.js:2876-2899` (`_buildEnglishPrompt`)
- UI 스타일 관리 모달: `rebuild/ui/index.html:1613-1620` (공통 키워드 입력란), 4740- 행 (목록 렌더)
- 사용자 스타일 저장: `~/.flow-app/styles.json`
- 사용자 순서 저장: `~/.flow-app/style-order.json`
