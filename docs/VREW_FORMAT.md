# `.vrew` 파일 작성 가이드 (Vrew 4.0.1)

> Vrew 4.0.1 에서 **에러 없이 열리고**, **음성이 들리고**, **이미지가 표시되고**, **자막이 분할되어 보이는** `.vrew` 파일을 다른 프로그램에서도 만들 수 있도록 정리한 형식 명세 + 시행착오 모음. PrimingFlow 의 `vrew/vrew-builder.js` 가 이 명세 그대로 구현되어 있음.

---

## 0. 한 줄 요약

`.vrew` = **ZIP 파일** = `project.json` + `media/<mediaId>.<ext>` 들의 묶음. 핵심은 **`ttsClip` 트랙이 실제 음성 mp3 의 mediaId 를 직접 가리키고 sourceIn/sourceOut 으로 시간 슬라이스, `volume: 1`** 로 두는 것. 그 외 형식적 함정이 다수 있음 (아래).

---

## 1. 파일 구조

```
my_project.vrew                    ← ZIP 파일 (확장자만 .vrew)
├── project.json                   ← 단일 메타 + 트랙 + 자산 정의 (필수)
└── media/                         ← 모든 미디어 바이너리
    ├── <mediaId>.mp3              ← TTS 음성 (sentence 마다 1개)
    ├── <UUID>.jpg                 ← 그룹 이미지 (또는 png/webp)
    ├── <UUID>.png                 ← 채널 로고 (선택)
    └── uc-0010-simple-textbox.bin ← AI 고지 자막용 시스템 HTML (선택, 965 byte)
```

### 1.1 ZIP 만드는 법

표준 zip 라이브러리 사용. **압축 레벨 무관**. **저장 (no compression) 도 동작**. `project.json` 은 ZIP 의 최상위에 둘 것 (`media/project.json` 처럼 폴더 안에 넣지 말 것).

```javascript
// Node.js (adm-zip) 예
const zip = new AdmZip();
zip.addLocalFile('project.json');
for (const f of fs.readdirSync('media').sort()) {
  zip.addLocalFile(`media/${f}`, 'media');
}
zip.writeZip('my_project.vrew');
```

```python
# Python 예
import zipfile
with zipfile.ZipFile('my_project.vrew', 'w', zipfile.ZIP_DEFLATED) as z:
    z.write('project.json', 'project.json')
    for f in os.listdir('media'):
        z.write(f'media/{f}', f'media/{f}')
```

---

## 2. `project.json` 최상위 스키마

```jsonc
{
  "version": 16,                              // 고정 (Vrew 내부 스키마 버전)
  "files": [ /* 미디어 파일 항목 배열 */ ],   // §3
  "transcript": {                             // §4
    "clips": [ /* 자막 단위 clip 배열 */ ],
    "sceneNames": {},                         // 씬 이름 매핑 (비워둬도 OK)
    "translateInfo": null                     // 번역 정보 (없으면 null)
  },
  "props": {                                  // §5
    "tracks": { /* trackId → 트랙 객체 */ },
    "assets": { /* assetId → asset 객체 */ },
    "ttsClipInfosMap": { /* mediaId → 화자/텍스트 메타 */ },
    "originalClips": [],                      // []
    "lastTTSSettings": { /* 마지막 화자 설정 */ },
    /* 그 외 globalCaptionStyle, videoSize 등 → vrew-template.json 에서 복사 */
  },
  "comment": "4.0.1\t<ISO 시각>",             // 버전 라벨 + 작성 시각
  "projectId": "<UUID>",
  "statistics": {
    "saveInfo": {
      "created": { "version": "4.0.1", "date": "<ISO>", "stage": "release" },
      "updated": { "version": "4.0.1", "date": "<ISO>", "stage": "release" },
      "loadCount": 0,
      "saveCount": 1
    },
    /* 그 외 통계 필드들 → vrew-template.json 에서 복사 */
  }
}
```

### 2.1 `version` 라벨

| 라벨 | 동작 | 권장 |
|---|---|---|
| `"3.8.0"` | Vrew 4.0.1 이 호환해서 열어줌, 음성도 정상 | ✅ |
| `"4.0.1"` | Vrew 4.0.1 native, 음성도 정상 | ✅ |
| `"3.8.0"` 인데 일부 4.0.1 키 (`id`, `captionMode`) 사용 | ✅ 작동 (서기 vrew 가 이 형태) | ✅ |

→ 그냥 **`"4.0.1"`** 로 통일 권장. (현재 PrimingFlow 빌더가 4.0.1 사용)

### 2.2 템플릿 이용

`project.json` 의 톱레벨 필드 중 사용자 콘텐츠와 무관한 부분 (videoRatio, videoSize, globalCaptionStyle, mediaEffectMap, captionDisplayMode, 통계 …) 은 매번 새로 만들기 부담스럽다. **빈 Vrew 프로젝트 1개를 한 번 만들어 그 `project.json` 을 템플릿으로 보존**하고 매 빌드마다 그 템플릿을 깊은 복사한 뒤 `files` / `transcript.clips` / `props.tracks` / `props.assets` 만 채우는 방식 권장.

PrimingFlow 의 `rebuild/vrew-template.json` 이 그 템플릿 — Vrew 4.0.1 에서 빈 프로젝트 저장한 결과물 그대로.

### 2.3 **고정 미디어** — `10000000-0000-0000-0000.mp4`

템플릿 `files[0]` 에 다음 항목이 박혀있어야 함 (빈 프로젝트가 자동 생성하는 시스템 더미 영상). **삭제하면 안 됨**.

```json
{
  "version": 1, "mediaId": "10000000-0000-0000-0000",
  "sourceOrigin": "VREW_RESOURCE", "fileSize": 176444,
  "name": "10000000-0000-0000-0000.mp4", "type": "AVMedia",
  "videoAudioMetaInfo": { "duration": 1, "audioInfo": { "sampleRate": 44100, "codec": "wav", "channelCount": 1 } },
  "sourceFileType": "VIDEO_AUDIO", "fileLocation": "IN_MEMORY"
}
```

ZIP 안에 실제 mp4 바이너리는 동봉할 필요 없음 (Vrew 가 mediaId 로만 인식). 단 `files[0]` 메타 항목은 반드시 있어야 함.

---

## 3. `files[]` — 미디어 파일 항목

각 미디어 파일은 `files[]` 배열의 한 항목 + ZIP 의 `media/<name>` 으로 등록. **mediaId 는 항목 사이에 유일**.

### 3.1 항목 4종

| 종류 | `type` | `sourceFileType` | `sourceOrigin` | mediaId 형식 | name |
|---|---|---|---|---|---|
| 시스템 mp4 더미 | `"AVMedia"` | `"VIDEO_AUDIO"` | `"VREW_RESOURCE"` | `10000000-0000-0000-0000` (고정) | `<id>.mp4` |
| **TTS 음성** | `"AVMedia"` | `"TTS"` | `"VREW_RESOURCE"` | 10자리 hex (예: `be58df49a4`) | `<id>.mp3` 또는 `<id>.wav` |
| 그룹 이미지 / 로고 | `"Image"` | (없음) | `"USER"` | UUID v4 | `<UUID>.jpg` 등 |
| AI 고지 텍스트박스 | `"Html"` | (없음) | `"USER"` | `uc-0010-simple-textbox` (고정) | `uc-0010-simple-textbox.html` |

### 3.2 TTS 음성 파일 항목

```json
{
  "version": 1,
  "mediaId": "<10자리 hex, 예: be58df49a4>",
  "sourceOrigin": "VREW_RESOURCE",
  "fileSize": 28800,                          // 실제 mp3 byte
  "name": "be58df49a4.mp3",                   // ZIP 안 미디어 파일명과 동일
  "type": "AVMedia",
  "videoAudioMetaInfo": {
    "duration": 4.8,                          // 실제 음성 길이 (초)
    "audioInfo": { "sampleRate": 24000, "codec": "mp3", "channelCount": 1 }
  },
  "sourceFileType": "TTS",                    // ★ 핵심
  "fileLocation": "IN_MEMORY"
}
```

**핵심 규칙**:
- `sourceFileType: "TTS"` 로 등록 (TTS_DUBBING 절대 X — §6 참고)
- ZIP 안 파일명과 `name` 필드가 정확히 일치
- `fileSize` 는 **실제 byte 수** (불일치하면 Vrew 가 거부할 수 있음)
- mp3 권장: MPEG ADTS Layer III v2, 24kHz, mono, 48~64 kbps (test.vrew / reference 와 동일)

### 3.3 이미지 파일 항목

```json
{
  "version": 1,
  "mediaId": "64366e4f-ee4f-4d59-8472-bced20636571",   // UUID v4 (10hex 아님)
  "sourceOrigin": "USER",
  "fileSize": 756843,
  "name": "64366e4f-ee4f-4d59-8472-bced20636571.jpg",  // UUID + 확장자
  "type": "Image",
  "isTransparent": false,                              // png 면 true 권장
  "fileLocation": "IN_MEMORY"
}
```

**핵심 규칙**:
- 이미지의 mediaId 는 **UUID** 형식 (10hex 아님 — Vrew 의 내부 구분)
- `name` = `<mediaId>.<ext>` (확장자만 jpg/png/webp)
- 투명 png 면 `isTransparent: true`

### 3.4 AI 고지 자막용 Html 항목 (선택)

```json
{
  "version": 1, "mediaId": "uc-0010-simple-textbox",
  "sourceOrigin": "USER", "fileSize": 965,
  "name": "uc-0010-simple-textbox.html",      // ★ .html
  "type": "Html", "fileLocation": "IN_MEMORY"
}
```

**❗ 확장자 비대칭**:
- `files[].name` 은 `uc-0010-simple-textbox.html` (확장자 `.html`)
- ZIP 안 실제 파일명은 `media/uc-0010-simple-textbox.bin` (확장자 `.bin`)
- Vrew 가 mediaId 로 매칭하므로 **그대로 따라야 함**. 둘 다 .html 로 통일하면 동작 안 할 수 있음.

`uc-0010-simple-textbox.bin` 의 정확한 본문 (965 byte) 은 Vrew 시스템 리소스 — Vrew 4.0.1 에서 텍스트박스 1개 추가한 빈 프로젝트의 ZIP 에서 추출.

---

## 4. `transcript.clips[]` — 자막 클립

**한 sub-clip = transcript.clips 의 한 항목**. (한 sentence 가 여러 sub-clip 으로 분할되면 그만큼 clip 항목이 늘어남)

### 4.1 clip 항목 형식

```json
{
  "sceneId": "<10hex, 모든 clip 공유 단일 값>",
  "id": "<10hex>",                            // ★ "clipId" 아님
  "captionMode": "MANUAL",                    // ★ 필수
  "words": [ /* §4.2 */ ],
  "captions": [ /* §4.3 */ ],
  "assetIds": [
    "<group image asset UUID>",
    "<logo asset UUID>"                       // 로고 사용 시
  ],
  "dirty": { "blankDeleted": false, "caption": false, "video": false },
  "translationModified": { "result": false, "source": false }
}
```

### 4.2 `words[]` — 자막 시간 분할

이 배열이 자막의 시간 구조를 결정. **각 clip 은 정확히 2개 word**:

```json
[
  {
    "id": "<10hex>",
    "text": "복숭아꽃이 흩날리는 가운데",      // sub-clip 텍스트
    "playbackRate": 1,
    "duration": 2.5,                          // sub-clip 노출 초
    "aligned": false,
    "type": 0,                                // 0 = 일반 sub-clip
    "originalDuration": 2.5,
    "originalStartTime": 0,
    "truncatedWords": [],
    "assetIds": [ "<ttsClip asset UUID>" ]    // 이 sub-clip 의 음성 트랙
  },
  {
    "id": "<10hex>", "text": "",
    "playbackRate": 1, "duration": 0,
    "aligned": false,
    "type": 2,                                // 2 = 종료 마커
    "originalDuration": 0,
    "originalStartTime": 2.5,
    "truncatedWords": [], "assetIds": []
  }
]
```

**규칙**:
- 첫 word `type: 0`, 마지막 word `type: 2` (종료 마커, text="", duration=0, assetIds=[])
- 첫 word 의 `assetIds` 길이 = 1 (해당 sub-clip 의 ttsClip asset)
- 마지막 word 의 `assetIds` = `[]`

### 4.3 `captions[]` — 자막 텍스트 (Quill 형식)

```json
[
  { "text": [
    { "attributes": {
        "font": "Pretendard-Vrew_700",
        "size": "150",
        "color": "#ffffff",
        "outline-on": "true",
        "outline-color": "#000000",
        "outline-width": "6"
      }, "insert": "복숭아꽃이 흩날리는 가운데" },
    { "insert": "\n" }
  ] },
  { "text": [ { "insert": "\n" } ] }
]
```

첫 quill block: 자막 본문 (attributes 적용 + `\n`).  
두 번째 quill block: 빈 줄 (`\n` 만).

### 4.4 sceneId

**모든 clip 이 같은 sceneId 사용** (단일 씬). 별개 씬으로 나누면 화면 전환이 발생. `transcript.sceneNames` 는 비워둬도 OK (Vrew 가 자동 처리).

---

## 5. `props.tracks{}` — 트랙 객체들

`tracks` 는 `{trackId: 트랙객체, ...}` 형식 dict. trackId 는 10자리 hex.

### 5.1 ttsClip 트랙 (★ 음성의 핵심)

```json
"<10hex>": {
  "trackId": "<10hex>",
  "mediaId": "<TTS file 의 mediaId>",         // ★ 실제 음성 파일을 직접 가리킴
  "volume": 1,                                // ★ 절대 0 이면 안 됨 (음소거)
  "sourceIn": 0,                              // 음성의 시작 슬라이스 (초)
  "sourceOut": 2.5,                           // 음성의 끝 슬라이스 (초)
  "loop": false,
  "fade": { "in": false, "out": false },
  "playbackRate": 1,
  "type": "ttsClip"
}
```

**규칙**:
- `mediaId` = 실제 TTS 음성 파일의 mediaId (TTS_DUBBING / dummy 아님)
- `sourceIn / sourceOut` = 같은 sentence 의 음성을 sub-clip 시간만큼 슬라이스. 첫 sub-clip = 0~T1, 두 번째 = T1~T2, …
- 한 sentence 의 N 개 sub-clip 은 **같은 mediaId 공유** (다른 trackId, 다른 sourceIn/Out)
- `volume: 1` 필수 (`0` 은 음소거 — 가장 많이 빠지는 함정)

### 5.2 image 트랙

```json
"<10hex>": {
  "trackId": "<10hex>",
  "mediaId": "<Image file 의 mediaId UUID>",
  "xPos": -0.004, "yPos": 0,                  // 0~1 범위 화면 비율
  "height": 1, "width": 1.008,                // 풀스크린 = 1
  "rotation": 0, "zIndex": 0,
  "type": "image",
  "originalWidthHeightRatio": 1.7778,         // 16:9 = 1.7778
  "kenburnsAnimationInfo": {
    "type": "custom",
    "from": { "scale": 0.668, "centerX": 0.531, "centerY": 0.354 },
    "to":   { "scale": 0.98,  "centerX": 0.51,  "centerY": 0.51  }
  },
  "editInfo": {},
  "stats": { "fillType": "cut", "fillMenu": "floating", "rearrangeCount": 0 }
}
```

### 5.3 web 트랙 (AI 고지 자막용)

```json
"<10hex>": {
  "trackId": "<10hex>",
  "mediaId": "uc-0010-simple-textbox",
  "xPos": 0.02, "yPos": 0.047,                // 좌상단 기본
  "height": 0, "width": 0.6,                  // height=0 = 텍스트 크기 따라 자동
  "rotation": 0, "zIndex": 51,                // 다른 트랙보다 위
  "type": "web",
  "deltas": {
    "textarea": {
      "ops": [
        { "insert": "본 영상의 음성과 이미지는 AI 도구를 활용하여 제작되었습니다.",
          "attributes": { "font": "Pretendard-Vrew_700", "size": "75", "color": "#ffffff" } },
        { "insert": "\n" }
      ]
    }
  },
  "loop": true,
  "durationSeconds": 0,                       // 0 = 끝까지, >0 = N초만
  "importType": "textbox_toolbar",
  "enabledInlineTypes": ["bold","italic","font","size","color","background","outline-color","shadow-color"],
  "customAttributes": [
    { "attributeName": "--textbox-color", "type": "color-hex", "value": "#00000000" },
    { "attributeName": "--textbox-align", "type": "textbox-align", "value": "start" }
  ],
  "assetEffectInfo": { "type": "fade-in", "duration": 1500, "startDelay": 5000 },
  "stats": { "styledInFloatingMenu": true, "styledInPanel": false },
  "scaleFactor": 1.7777777777777777
}
```

**시간 제어**:
- 시작: `assetEffectInfo.startDelay` (ms)
- 노출 시간: `durationSeconds` (s, `0` = 끝까지)

---

## 6. ★ 가장 큰 함정: ttsDubbing vs ttsClip

### 시행착오 기록

3.8.0 형식 (외부 도구 산출물) 을 분석했을 때 다음과 같이 보였음:

```
ttsDubbing 트랙: 실제 음성 mediaId, volume:0
ttsClip 트랙   : dummy 5036byte mp3 mediaId, volume:0
```

이 형식을 그대로 복제했더니 **Vrew 4.0.1 에서 음성 재생 안 됨**. `volume:0` 이 음소거였음.

### 4.0.1 의 정답 형식 (test.vrew 분석)

```
ttsDubbing 트랙: 사용 안 함 ❌
ttsClip 트랙   : 실제 음성 mediaId 직접 가리킴, sourceIn/sourceOut 슬라이스, volume:1
dummy mp3      : 사용 안 함 ❌
TTS_DUBBING    : 사용 안 함 ❌
```

**결론**: Vrew 4.0.1 에서는 **`ttsClip` 만 쓰고 실제 음성을 직접 가리키며 `volume: 1`** 로 둘 것. 다른 변형 (ttsDubbing slicing, dummy 사용 등) 은 모두 음성 무 또는 파일 거부로 이어짐.

---

## 7. `props.assets{}` — 자산 매핑

`assets` 는 `{assetId: {trackIds:[...], role:"main"|"sub"}, ...}` dict. assetId 는 UUID v4.

### 7.1 role 분포 규칙

| 트랙 type | role | 의미 |
|---|---|---|
| `ttsClip` | `"main"` | 메인 자막/음성 단위 |
| `image` | `"sub"` | 배경 이미지 |
| `web` | `"sub"` | 오버레이 텍스트박스 |

### 7.2 trackIds

각 asset 은 **딱 1개 trackId 를 가리킴** (`trackIds: [tid]` 길이 1).

### 7.3 등록 규칙

- ttsClip asset: clip 의 `words[0].assetIds` 에 등록
- image (그룹) asset: clip 의 `assetIds` 에 등록 (모든 clip 에 같은 그룹 asset)
- image (로고) asset: 모든 clip 의 `assetIds` 에 등록 (영상 전체 표시)
- web asset: clip 에 등록하지 않음 (`props.tracks` + `props.assets` 만)

---

## 8. `props.ttsClipInfosMap{}`

화자/텍스트 메타. **ttsClip 트랙이 가리키는 mediaId 별로 1개 항목**.

```json
"<TTS file 의 mediaId>": {
  "pitch": 0, "speed": 0, "volume": 0,
  "speaker": {
    "gender": "female", "age": "middle",
    "provider": "vrew", "lang": "ko-KR",
    "name": "butter_f", "speakerId": "characteristic2",
    "badge": "Recommended",
    "tags": ["_characteristic","cheesy","badgirl"],
    "versions": ["v4"], "isUnavailable": false
  },
  "version": "v4",
  "text": {
    "raw": "복숭아꽃이 흩날리는 가운데, 세 남자가 무릎을 꿇었습니다.",
    "processed": "복숭아꽃이 흩날리는 가운데 세 남자가 무릎을 꿇었습니다",
    "textAspectLang": "ko-KR"
  },
  "duration": 4.8                             // sentence 음성 길이
}
```

**규칙**: 한 sentence 에 N 개 sub-clip (= N ttsClip 트랙) 이 있어도 같은 mediaId 면 ttsClipInfosMap 항목은 **1개**.

### speaker 객체

`speaker.provider` 가 `"vrew"` 면 Vrew 내부 화자 (`butter_f`, `characteristic2` 등 이름). `"google"` / `"azure"` / 등은 외부 TTS provider 의 voice 정보 — 정확한 형식은 해당 provider 의 voiceId 따름.

PrimingFlow 는 외부 TTS (msedge, OmniVoice 등) 를 쓰지만 **Vrew 표시용 speaker 메타는 `butter_f` 로 둠** — Vrew UI 에서 화자 라벨이 보일 뿐, 실제 재생되는 mp3 와는 무관.

---

## 9. 데이터 모델 매핑 (sentence ↔ sub-clip ↔ vrew 단위)

```
입력:
  sentence (1 mp3 음성 단위)
  └── sub-clips[] (긴 문장은 N 개로 시간 분할, 짧은 문장은 1개)

vrew 산출:
  files[]:
    1× TTS file (sentence 당, mediaId=10hex, 실제 mp3)

  props.tracks{}:
    N× ttsClip 트랙 (sub-clip 마다 1개, 같은 mediaId, sourceIn/sourceOut 시간 슬라이스)

  props.assets{}:
    N× ttsClip asset (트랙 1:1 매핑, role:'main')

  props.ttsClipInfosMap{}:
    1× entry (sentence 당, key = TTS mediaId)

  transcript.clips[]:
    N× clip (sub-clip 마다 1개, words=[type:0 word + type:2 종료], captions=sub-clip 텍스트)
```

### 9.1 시간 슬라이싱 예시

sentence 음성 4.8s, sub-clip 2개 (가중치 2.5, 2.3 비율):

| sub-clip i | sourceIn | sourceOut | duration |
|---|---|---|---|
| 0 | 0 | 2.5 | 2.5 |
| 1 | 2.5 | 4.8 | 2.3 |

마지막 sub-clip 의 `sourceOut` 은 항상 sentence 전체 duration 으로 (반올림 누적 오차 방지).

---

## 10. 그룹 이미지 (sentence 묶음 → 이미지 1장)

여러 sentence 가 한 이미지를 공유하는 경우 (PrimingFlow 의 "그룹"):

```
group:
  - sentenceIds: [s1, s2, s3]
  - imagePath: '/path/to/group_01.jpg'

vrew 산출:
  files[]:
    1× Image file (mediaId=UUID)

  props.tracks{}:
    1× image 트랙 (mediaId 가리킴, kenburnsAnimationInfo)

  props.assets{}:
    1× image asset (role:'sub')

  transcript.clips[]:
    s1, s2, s3 의 모든 sub-clip clip 의 assetIds 에 같은 image asset UUID 등록
```

**규칙**:
- 그룹 이미지 1장 = vrew 의 image 트랙 1개. 그룹 안 sentence 들의 모든 sub-clip clip 이 그 같은 asset 을 공유 (`clip.assetIds[0]`).
- 같은 그룹의 모든 clip 동안 같은 이미지가 보임 (Ken Burns 애니메이션 적용).

---

## 11. 채널 로고 오버레이 (선택)

영상 전체에 작은 로고를 표시하고 싶을 때:

```
files[]:
  1× Image file (UUID, sourceOrigin:'USER', isTransparent:true if png)

props.tracks{}:
  1× image 트랙
    - 위치: xPos/yPos = 모서리 (예: 우상단 → xPos=0.83, yPos=0.02)
    - 크기: width/height = 0.10 ~ 0.20 (작게)
    - zIndex: 그룹 이미지보다 위 (예: 50+)
    - type: 'image'
    - kenburnsAnimationInfo 없이도 OK (정적 표시)

props.assets{}:
  1× asset (role:'sub')

transcript.clips[]:
  모든 clip 의 assetIds 에 logo asset UUID 추가 (그룹 image asset 다음에)
```

위치/크기 프리셋 예 (PrimingFlow):

| position | size | xPos | yPos | width | height |
|---|---|---|---|---|---|
| top-right | medium | 0.83 | 0.02 | 0.15 | 0.15 |
| top-left | small | 0.02 | 0.02 | 0.10 | 0.10 |
| bottom-right | large | 0.78 | 0.78 | 0.20 | 0.20 |

(여백 margin = 0.02, xPos 우측 = 1 - width - margin)

---

## 12. AI 고지 자막 (선택)

§5.3 의 `web` 트랙 + §3.4 의 Html files 항목 + ZIP 의 `media/uc-0010-simple-textbox.bin` (965 byte).

**Vrew 시스템 리소스 의존**:
- `uc-0010-simple-textbox.bin` 은 Vrew 가 제공하는 HTML 텍스트박스 템플릿. 우리가 만들 수 없음.
- 빈 Vrew 4.0.1 프로젝트에 텍스트박스 1개 추가 후 저장 → 그 ZIP 에서 `media/uc-0010-simple-textbox.bin` 추출해서 보존.
- **확장자 비대칭** (§3.4) 그대로 따를 것.

**텍스트는 `deltas.textarea.ops[]`** 의 quill delta 로 박힘. HTML 본문에는 텍스트가 없음 (HTML 은 단순 템플릿). 사용자가 자막 문구 변경 시 deltas 만 갱신.

---

## 13. 검증 절차

### 13.1 빌드 직후 self-check

빌더가 자동으로 다음을 검사:

```javascript
function validateOutput(pj, sentenceCount, imageGroupCount) {
  // 1. files[0] 이 시스템 mp4 더미인가
  assert(pj.files[0].mediaId === '10000000-0000-0000-0000');

  // 2. TTS file 수 == sentence 수
  assert(pj.files.filter(f => f.sourceFileType === 'TTS').length === sentenceCount);

  // 3. Image file 수 >= 그룹 수 (로고 있으면 +1)
  assert(pj.files.filter(f => f.type === 'Image').length >= imageGroupCount);

  // 4. 모든 ttsClip 트랙의 mediaId 가 files[] 에 존재
  const fileMids = new Set(pj.files.map(f => f.mediaId));
  for (const t of Object.values(pj.props.tracks)) {
    assert(fileMids.has(t.mediaId));
  }

  // 5. 모든 asset 의 trackIds[0] 이 tracks 에 존재
  for (const a of Object.values(pj.props.assets)) {
    assert(pj.props.tracks[a.trackIds[0]]);
  }

  // 6. clip 마다 words 길이 정확히 2 (sub-clip + 종료 마커)
  for (const c of pj.transcript.clips) {
    assert(c.words.length === 2);
    assert(c.words[0].type === 0);
    assert(c.words[1].type === 2);
    assert(c.words[1].assetIds.length === 0);
  }

  // 7. asset role 분포
  for (const a of Object.values(pj.props.assets)) {
    const tt = pj.props.tracks[a.trackIds[0]].type;
    if (tt === 'ttsClip')   assert(a.role === 'main');
    if (tt === 'image')     assert(a.role === 'sub');
    if (tt === 'web')       assert(a.role === 'sub');
  }

  // 8. web 트랙이 있으면 files[] 에 Html (uc-0010-simple-textbox) 등록
  const hasWebTrack = Object.values(pj.props.tracks).some(t => t.type === 'web');
  if (hasWebTrack) {
    assert(pj.files.some(f => f.mediaId === 'uc-0010-simple-textbox' && f.type === 'Html'));
  }
}
```

### 13.2 reference vrew 와 키 구조 비교

```python
import json, zipfile, re
from collections import Counter

UUID = re.compile(r'^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$')
HEX10 = re.compile(r'^[0-9a-f]{10}$')

def normalize_key(k):
    if UUID.match(k): return '<UUID>'
    if HEX10.match(k): return '<HEX10>'
    return k

def extract_paths(obj, prefix='', acc=None):
    if acc is None: acc = set()
    if isinstance(obj, dict):
        for k, v in obj.items():
            extract_paths(v, prefix + '.' + normalize_key(k) if prefix else normalize_key(k), acc)
    elif isinstance(obj, list):
        if obj:
            for it in obj[:5]: extract_paths(it, prefix + '[]', acc)
        else: acc.add(prefix + '[](empty)')
    else: acc.add(prefix)
    return acc

with zipfile.ZipFile('reference.vrew') as z:
    ref = json.load(z.open('project.json'))
with zipfile.ZipFile('our.vrew') as z:
    our = json.load(z.open('project.json'))

ref_keys = extract_paths(ref)
our_keys = extract_paths(our)
print('ref - our:', sorted(ref_keys - our_keys))   # 우리에게 누락
print('our - ref:', sorted(our_keys - ref_keys))   # ref 에 없음 (의도적이면 OK)
```

빈 집합이면 형식적으로 reference 와 동등. 추가 신규 트랙 (web, 로고) 이 있으면 `our - ref` 에 그 경로만 표시되어야 정상.

### 13.3 Vrew 4.0.1 직접 열기

- `.vrew` 더블 클릭 → "원인을 알 수 없는 오류" 팝업 없이 정상 로드
- 음성 재생 OK
- 자막이 sub-clip 단위로 분할 표시
- 이미지 트랙 보임
- (옵션) 로고 / AI 고지 자막 표시

### 13.4 Vrew 가 거부할 때 진단

1. `project.json` 추출 → JSON 파싱 가능한지 (JSON syntax error 가 가장 흔한 원인)
2. `files[0].mediaId === '10000000-0000-0000-0000'` 인지
3. `files[].fileSize` 가 ZIP 안 실제 byte 수와 일치하는지
4. 모든 트랙의 `mediaId` 가 `files[]` 에 등록되어 있는지
5. 모든 asset 의 `trackIds[0]` 이 `props.tracks` 에 있는지
6. `comment` 의 버전 라벨이 `"3.8.0"` 또는 `"4.0.1"` 인지
7. clip 의 `id` 가 있는지 (`clipId` 가 아님 — 4.0.1 변경)
8. `captionMode: "MANUAL"` 이 있는지 (4.0.1 필수)

---

## 14. 시행착오 함정 모음

### 14.1 음성 무 — `volume: 0`
3.8.0 reference 가 `volume: 0` 으로 되어있어 그대로 따라하면 음소거. 4.0.1 에서는 **`volume: 1`** 로.

### 14.2 음성 무 — ttsDubbing 사용
ttsDubbing 트랙은 4.0.1 에서 음성으로 재생 안 됨. **ttsClip 만 사용**.

### 14.3 자막 한 박스에 합쳐짐
1 sentence = 1 clip + N words 구조로 만들면 Vrew 가 한 자막 박스 안에 word 단위로만 시간 변경. 사용자가 sub-clip 별로 별개 자막 박스 보길 원하면 **1 sub-clip = 1 transcript.clips 항목** 으로 분리.

### 14.4 이미지 안 보임 — clip.assetIds 빈 배열
clip 의 `assetIds` 가 `[]` 면 이미지 트랙이 만들어져있어도 그 clip 에 이미지가 표시되지 않음. 그룹 image asset UUID 를 모든 sub-clip clip 의 `assetIds` 에 등록해야 함.

### 14.5 mediaId 형식 혼동
- **TTS 음성**: 10자리 hex (예: `be58df49a4`)
- **이미지**: UUID (예: `64366e4f-ee4f-4d59-8472-bced20636571`)
- **트랙 ID / clip ID / word ID**: 10자리 hex
- **asset ID**: UUID

→ 헬퍼 함수 분리:
```javascript
const uid = () => 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, c => {
  const r = Math.random()*16|0; return (c==='x'?r:(r&0x3|0x8)).toString(16);
});
const sid = () => uid().replace(/-/g, '').substring(0, 10);
```

### 14.6 uc-0010 .bin/.html 비대칭
ZIP 안은 `.bin`, files[].name 은 `.html`. Vrew 가 mediaId 로 매칭하므로 그대로 유지. `.html` 로 통일하면 동작 안 할 수 있음.

### 14.7 Electron file.path 가 빈 문자열
Electron 32+ 에서 `<input type="file">` 의 `file.path` 가 deprecated → 빈 문자열 반환. 사용:
```javascript
const { webUtils } = require('electron');
const filePath = webUtils.getPathForFile(file);
```

### 14.8 `clipId` vs `id`
3.8.0: `clipId`. 4.0.1: `id`. **4.0.1 에서는 `id` 사용**. `clipId` 로 두면 인식 안 함.

### 14.9 `captionMode` 누락
4.0.1 필수: `captionMode: "MANUAL"`. 빠지면 자막 인식 못 함.

### 14.10 dummy mp3 우회
3.8.0 형식이 dummy 5036byte mp3 를 ttsClip 에 사용했는데, 4.0.1 에서는 그러면 음성 무. **실제 음성 mp3 를 ttsClip 이 직접 가리킴**.

### 14.11 `transcript.sceneNames` 비어있어도 OK
clip 들이 같은 sceneId 를 공유하면 `sceneNames` 에 그 sceneId 항목을 추가하지 않아도 정상 작동.

### 14.12 ZIP 안 미디어 폴더 이름
`media/` 만 사용. `Media/`, `MEDIA/`, `media/sub/` 등은 인식 안 됨.

### 14.13 `fileSize` 불일치
`files[].fileSize` 가 ZIP 안 실제 byte 수와 다르면 Vrew 가 파일 거부. 빌더에서 항상 `fs.statSync(path).size` 로 실측해서 등록.

### 14.14 음성 mp3 인코딩
Vrew 가 받는 mp3: MPEG ADTS Layer III v2, 24kHz, mono, 48~64 kbps. 다른 형식 (예: 48kHz, stereo) 도 보통 동작하지만 일부 케이스 거부 가능. msedge-tts / OmniVoice 의 기본 출력이 위 형식이라 그대로 사용 권장.

---

## 15. 최소 동작 예시 (의사 코드)

가장 단순한 .vrew 만들기 — sentence 1개, sub-clip 1개, 그룹 이미지 1장:

```javascript
const fs = require('fs');
const path = require('path');
const AdmZip = require('adm-zip');

const TEMPLATE = JSON.parse(fs.readFileSync('vrew-template.json', 'utf-8'));

function uid() { return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, c => { const r = Math.random()*16|0; return (c==='x'?r:(r&0x3|0x8)).toString(16); }); }
function sid() { return uid().replace(/-/g,'').substring(0,10); }

const SPEAKER = {
  gender:'female', age:'middle', provider:'vrew', lang:'ko-KR',
  name:'butter_f', speakerId:'characteristic2', badge:'Recommended',
  tags:['_characteristic','cheesy','badgirl'], versions:['v4'], isUnavailable:false,
};

async function buildMinimal(ttsAudioPath, imagePath, text, ttsDur, outVrewPath) {
  const pj = JSON.parse(JSON.stringify(TEMPLATE));
  const now = new Date().toISOString();
  pj.comment = `4.0.1\t${now}`;
  pj.statistics.saveInfo.created = { version:'4.0.1', date:now, stage:'release' };
  pj.statistics.saveInfo.updated = { version:'4.0.1', date:now, stage:'release' };
  pj.props.tracks = {}; pj.props.assets = {};
  pj.props.ttsClipInfosMap = {}; pj.props.originalClips = [];
  pj.props.lastTTSSettings = { pitch:0, speed:0, volume:0, speaker:{...SPEAKER}, version:'v4' };
  pj.transcript.clips = [];
  pj.transcript.sceneNames = {}; pj.transcript.translateInfo = null;
  pj.projectId = uid();

  const sceneId = sid();
  const mediaZip = [];

  // 1. 그룹 이미지
  const imgMid = uid(), imgAid = uid(), imgTid = sid();
  const imgFn = `${imgMid}.jpg`;
  pj.files.push({
    version:1, mediaId:imgMid, sourceOrigin:'USER', fileSize: fs.statSync(imagePath).size,
    name:imgFn, type:'Image', isTransparent:false, fileLocation:'IN_MEMORY',
  });
  pj.props.tracks[imgTid] = {
    trackId:imgTid, mediaId:imgMid,
    xPos:-0.004, yPos:0, height:1, width:1.008, rotation:0, zIndex:0, type:'image',
    originalWidthHeightRatio:1.7778,
    kenburnsAnimationInfo:{ type:'custom', from:{scale:0.668,centerX:0.531,centerY:0.354}, to:{scale:0.98,centerX:0.51,centerY:0.51} },
    editInfo:{}, stats:{ fillType:'cut', fillMenu:'floating', rearrangeCount:0 },
  };
  pj.props.assets[imgAid] = { trackIds:[imgTid], role:'sub' };
  mediaZip.push({ src:imagePath, name:imgFn });

  // 2. TTS 음성
  const ttsMid = sid(), ttsAid = uid(), ttsTid = sid();
  const ttsFn = `${ttsMid}.mp3`;
  pj.files.push({
    version:1, mediaId:ttsMid, sourceOrigin:'VREW_RESOURCE',
    fileSize: fs.statSync(ttsAudioPath).size, name:ttsFn, type:'AVMedia',
    videoAudioMetaInfo:{ duration:ttsDur, audioInfo:{ sampleRate:24000, codec:'mp3', channelCount:1 } },
    sourceFileType:'TTS', fileLocation:'IN_MEMORY',
  });
  mediaZip.push({ src:ttsAudioPath, name:ttsFn });

  pj.props.ttsClipInfosMap[ttsMid] = {
    pitch:0, speed:0, volume:0, speaker:{...SPEAKER}, version:'v4',
    text:{ raw:text, processed:text, textAspectLang:'ko-KR' },
    duration: ttsDur,
  };

  pj.props.tracks[ttsTid] = {
    trackId:ttsTid, mediaId:ttsMid, volume:1,
    sourceIn:0, sourceOut:ttsDur, loop:false,
    fade:{in:false,out:false}, playbackRate:1, type:'ttsClip',
  };
  pj.props.assets[ttsAid] = { trackIds:[ttsTid], role:'main' };

  // 3. transcript clip
  pj.transcript.clips.push({
    sceneId, id:sid(), captionMode:'MANUAL',
    words:[
      { id:sid(), text, playbackRate:1, duration:ttsDur, aligned:false,
        type:0, originalDuration:ttsDur, originalStartTime:0,
        truncatedWords:[], assetIds:[ttsAid] },
      { id:sid(), text:'', playbackRate:1, duration:0, aligned:false,
        type:2, originalDuration:0, originalStartTime:ttsDur,
        truncatedWords:[], assetIds:[] },
    ],
    captions:[
      { text:[
        { attributes:{ font:'Pretendard-Vrew_700', size:'150', color:'#ffffff',
                       'outline-on':'true', 'outline-color':'#000000', 'outline-width':'6' },
          insert:text },
        { insert:'\n' } ] },
      { text:[ { insert:'\n' } ] },
    ],
    assetIds:[imgAid],
    dirty:{ blankDeleted:false, caption:false, video:false },
    translationModified:{ result:false, source:false },
  });

  // 4. ZIP 패키징
  const tmpDir = `${require('os').tmpdir()}/vrew_${Date.now()}`;
  fs.mkdirSync(`${tmpDir}/media`, { recursive:true });
  fs.writeFileSync(`${tmpDir}/project.json`, JSON.stringify(pj));
  for (const m of mediaZip) fs.copyFileSync(m.src, `${tmpDir}/media/${m.name}`);

  const zip = new AdmZip();
  zip.addLocalFile(`${tmpDir}/project.json`);
  for (const f of fs.readdirSync(`${tmpDir}/media`)) zip.addLocalFile(`${tmpDir}/media/${f}`, 'media');
  zip.writeZip(outVrewPath);

  fs.rmSync(tmpDir, { recursive:true, force:true });
}
```

---

## 16. 참고 자료

- PrimingFlow 의 빌더 본체: [`rebuild/vrew/vrew-builder.js`](../rebuild/vrew/vrew-builder.js)
- 템플릿 JSON: [`rebuild/vrew-template.json`](../rebuild/vrew-template.json)
- AI 고지 시스템 리소스: [`rebuild/vrew/dummy/uc-0010-simple-textbox.bin`](../rebuild/vrew/dummy/uc-0010-simple-textbox.bin)
- 분석 reference vrew (3.8.0 형식): `D:\PrimingFlow\서기 184년 한나_2026-05-02T22-19.vrew`
- 분석 reference vrew (4.0.1 음성 정상): `D:\PrimingFlow\test.vrew`
- 분석 reference vrew (AI 고지 + 본격 사례): `D:\PrimingFlow\대본_삼국지_제001회.vrew`

---

## 17. 변경 이력

- 2026-05-04: 첫 버전 작성. PrimingFlow 의 vrew-builder.js (Vrew 4.0.1 호환) 형식 명세.
