import zipfile, json, sys, re
sys.stdout.reconfigure(encoding='utf-8')
path = sys.argv[1]
out = sys.argv[2]
with zipfile.ZipFile(path) as z:
    pj = json.loads(z.read('project.json'))
    media = {e.filename: z.read(e.filename) for e in z.infolist() if e.filename != 'project.json'}
clips = pj['transcript']['clips']
assets = pj['props'].get('assets', {})
tracks = pj['props'].get('tracks', {})

def tts_clean(t):
    if not t: return t
    t = re.sub(r'[\u2013\u2014\u2e3b]', ' ', t)
    t = re.sub(r'[\x00-\x19]', '', t)
    t = re.sub(r'[\u2000-\u2012\u2015-\u2bff]', '', t)
    t = re.sub(r'[\u3003-\u303f\u3099-\u309c]', '', t)
    t = re.sub(r'[()*/+:;<=>\[\\\]^_{|}~@`\'"]', '', t)
    t = re.sub(r'[\u300a\u300b\u3008\u3009\u300c\u300d]', '', t)
    t = re.sub(r'\s+', ' ', t).strip()
    return t

def get_img(clip):
    for aid in clip.get('assetIds', []):
        if aid in assets:
            for tid in assets[aid].get('trackIds', []):
                if tid in tracks and tracks[tid].get('type') == 'image':
                    return aid
    return None

fixed = 0

# 1) 이미지 없는 클립 복구 (검은 배경 제거)
for i, clip in enumerate(clips):
    if not get_img(clip):
        for pi in range(i - 1, -1, -1):
            prev = get_img(clips[pi])
            if prev:
                clip['assetIds'] = [prev]
                fixed += 1
                break

# 1.5) TTS 자막 싱크: word duration을 TTS 실제 재생시간에 맞춤
#    단, Vrew가 AI 목소리를 적용한 경우(ttsClip vol>0) 건너뜀
#    → Vrew가 이미 타이밍을 맞춰놨으므로 다시 조정하면 오히려 깨짐
has_ai_voice = any(
    t.get('type') == 'ttsClip' and t.get('volume', 0) > 0
    for t in tracks.values() if isinstance(t, dict)
)
synced_up_to = -1
for i, clip in enumerate(clips):
    if has_ai_voice:
        break
    if i <= synced_up_to:
        continue
    tts_dur = None
    for w in clip.get('words', []):
        for aid in (w.get('assetIds') or []):
            a = assets.get(aid)
            if not a: continue
            for tid in (a.get('trackIds') or []):
                t = tracks.get(tid, {})
                if t.get('type') in ('ttsDubbing', 'ttsClip'):
                    tfi = t.get('ttsFileInfo') or {}
                    if tfi.get('duration', 0) > 0:
                        tts_dur = tfi['duration']
        if tts_dur is not None:
            break
    if tts_dur is None:
        continue
    # TTS가 커버하는 연속 클립들 (이 클립 + ttsDubbing 없는 후속 클립)
    group = [i]
    for j in range(i + 1, len(clips)):
        has_own = False
        for w in clips[j].get('words', []):
            for aid in (w.get('assetIds') or []):
                a = assets.get(aid)
                if not a: continue
                for tid in (a.get('trackIds') or []):
                    t = tracks.get(tid, {})
                    if t.get('type') in ('ttsDubbing', 'ttsClip'):
                        tfi = t.get('ttsFileInfo') or {}
                        if tfi.get('duration', 0) > 0:
                            has_own = True
            if has_own: break
        if has_own: break
        group.append(j)
    synced_up_to = group[-1]
    gw = []
    total_wd = 0
    for gi in group:
        for w in clips[gi].get('words', []):
            if w.get('type') in (0, 7):
                total_wd += w.get('duration', 0)
                gw.append(w)
    if total_wd <= 0 or abs(total_wd - tts_dur) < 0.05:
        continue
    scale = tts_dur / total_wd
    for w in gw:
        w['duration'] = max(0.05, w.get('duration', 0) * scale)
        w['originalDuration'] = w['duration']
    fixed += 1

# 1.55) 최소 클립 표시 시간 보장
#    TTS 싱크 후 글자 수 적은 클립이 너무 짧으면 이미지 애니메이션이 순식간에 지나감
#    → 최소 2초 보장, 부족분은 마지막 단어에 패딩
MIN_CLIP_DUR = 2.0
for clip in clips:
    words = [w for w in clip.get('words', []) if w.get('type') in (0, 7)]
    if not words:
        continue
    total_dur = sum(w.get('duration', 0) for w in words)
    if total_dur < MIN_CLIP_DUR:
        pad = MIN_CLIP_DUR - total_dur
        words[-1]['duration'] = words[-1].get('duration', 0) + pad
        words[-1]['originalDuration'] = words[-1]['duration']

# 1.6) 볼륨은 건드리지 않음
# Vrew가 AI 목소리 적용 후 설정한 볼륨을 유지해야 함
# (우리 dummy 트랙은 생성 시 이미 vol=0으로 만들어져 있음)

# 1.7) 분할 클립 합치기: ttsDubbing 없는 클립을 이전 클립과 병합
#    Vrew가 AI 목소리 적용 시 하나의 TTS로 생성한 문장을 여러 클립으로 분할하면
#    TTS 텍스트(미디어 메타)와 자막(word 텍스트)이 불일치 → 합쳐서 해결
def _get_dub(ci):
    for w in clips[ci].get('words', []):
        for aid in (w.get('assetIds') or []):
            a = assets.get(aid)
            if not a: continue
            for tid in (a.get('trackIds') or []):
                t = tracks.get(tid, {})
                if t.get('type') == 'ttsDubbing':
                    tfi = t.get('ttsFileInfo') or {}
                    if tfi.get('duration', 0) > 0:
                        return t
    return None

merge_groups = []
i = 0
while i < len(clips):
    if _get_dub(i) is not None:
        children = []
        for j in range(i + 1, len(clips)):
            if _get_dub(j) is not None:
                break
            children.append(j)
        if children:
            merge_groups.append((i, children))
        i = (children[-1] if children else i) + 1
    else:
        i += 1

for parent_idx, child_idxs in reversed(merge_groups):
    parent = clips[parent_idx]
    for ci in child_idxs:
        child = clips[ci]
        end_idx = next((wi for wi, w in enumerate(parent['words']) if w.get('type') == 2), len(parent['words']))
        child_words = [w for w in (child.get('words') or []) if w.get('type') != 2]
        parent['words'] = parent['words'][:end_idx] + child_words + parent['words'][end_idx:]
    # caption 업데이트
    all_text = ' '.join((w.get('text') or '') for w in parent['words'] if w.get('type') in (0, 7)).strip()
    for cap in (parent.get('captions') or []):
        for item in (cap.get('text') or []):
            if item.get('insert', '') != '\n':
                item['insert'] = all_text
                break
    # ttsDubbing text 업데이트
    dub = _get_dub(parent_idx)
    if dub and dub.get('ttsFileInfo', {}).get('text'):
        dub['ttsFileInfo']['text']['processed'] = all_text
        dub['ttsFileInfo']['text']['raw'] = all_text
    # 자식 클립 삭제 (뒤에서부터)
    for ci in reversed(child_idxs):
        del clips[ci]
        fixed += 1

# 2) 전체 클립 originalStartTime 연속 타임라인 (단락 딜레이 제거)
#    같은 단락(이미지) 내: 텀 없이 이어짐
#    단락 전환 시: 0.3초 짧은 텀만
cumulative = 0
prev_img = None
for i, clip in enumerate(clips):
    img = get_img(clip)
    # 단락 전환 시 짧은 텀
    if prev_img is not None and img != prev_img:
        cumulative += 0.3
    prev_img = img
    words = clip.get('words', [])
    for w in words:
        if w.get('type') in (0, 7):
            old = w.get('originalStartTime', 0)
            w['originalStartTime'] = cumulative
            w['originalDuration'] = w.get('duration', 0)
            cumulative += w.get('duration', 0)
            if abs(old - w['originalStartTime']) > 0.001:
                fixed += 1
        elif w.get('type') == 2:
            w['originalStartTime'] = cumulative

# 3) ttsDubbing 복구:
#    - volume 0→1
#    - text를 해당 클립 caption의 실제 텍스트로 복원 (정상 작동 .vrew 구조 일치)
#    - 빈 클립(대사 없는 영상 전용)은 ttsDubbing 트랙 삭제

# 먼저 각 ttsDubbing track이 어느 clip에 속하는지 매핑
dub_to_clip_idx = {}  # dub_track_id -> clip_index
clip_caption_text = {}  # clip_index -> caption text
empty_clip_indexes = set()

for ci, clip in enumerate(clips):
    # caption 텍스트 추출
    cap_text = ''
    for cap in (clip.get('captions') or []):
        for item in (cap.get('text') or []):
            ins = (item.get('insert') or '').replace('\n','').strip()
            if ins:
                cap_text = ins
                break
        if cap_text: break
    # 단어 텍스트도 확인
    word_text = ' '.join([(w.get('text') or '').strip() for w in (clip.get('words') or []) if w.get('type') != 2]).strip()
    final_text = cap_text or word_text
    clip_caption_text[ci] = final_text
    if not final_text:
        empty_clip_indexes.add(ci)
    # 이 클립에 연결된 ttsDubbing 트랙 찾기
    for w in (clip.get('words') or []):
        for aid in (w.get('assetIds') or []):
            a = assets.get(aid)
            if not a or a.get('role') != 'sub': continue
            for tid in (a.get('trackIds') or []):
                if tracks.get(tid, {}).get('type') == 'ttsDubbing':
                    dub_to_clip_idx[tid] = ci

# 빈 클립의 ttsDubbing 트랙 제거
removed_empty = 0
for tid in list(dub_to_clip_idx.keys()):
    ci = dub_to_clip_idx[tid]
    if ci in empty_clip_indexes:
        # 트랙 삭제
        if tid in tracks:
            del tracks[tid]
            fixed += 1
            removed_empty += 1
        # 관련 asset 삭제 + word.assetIds 에서 제거
        aid_to_remove = None
        for aid, a in list(assets.items()):
            if tid in (a.get('trackIds') or []):
                aid_to_remove = aid
                del assets[aid]
                break
        if aid_to_remove:
            for w in (clips[ci].get('words') or []):
                if aid_to_remove in (w.get('assetIds') or []):
                    w['assetIds'] = [x for x in w['assetIds'] if x != aid_to_remove]

# 남은 ttsDubbing 복구: 볼륨은 0 유지(새 Vrew 더빙과 겹치지 않게), text만 정리
for tid, t in tracks.items():
    if not isinstance(t, dict) or t.get('type') != 'ttsDubbing':
        continue
    tfi = t.get('ttsFileInfo') or {}
    tx = tfi.get('text')
    if isinstance(tx, dict):
        ci = dub_to_clip_idx.get(tid)
        new_text = clip_caption_text.get(ci, ' ') if ci is not None else ' '
        new_text = tts_clean(new_text) or ' '
        if tx.get('raw') != new_text:
            tx['raw'] = new_text
            fixed += 1
        if tx.get('processed') != new_text:
            tx['processed'] = new_text

# 3 pre) 따옴표/괄호 먼저 제거 → 이후 빈 클립 판정이 정확해짐
def strip_quotes(t):
    if not t: return t
    return re.sub(r'[()\'"]', '', t)

for c in clips:
    for w in (c.get('words') or []):
        if 'text' in w:
            nw = strip_quotes(w['text'])
            if nw != w['text']:
                w['text'] = nw
                fixed += 1
    for cap in (c.get('captions') or []):
        for item in (cap.get('text') or []):
            if 'insert' in item and item['insert'] != '\n':
                ni = strip_quotes(item['insert'])
                if ni != item['insert']:
                    item['insert'] = ni
                    fixed += 1

# 3a) 빈 클립(대사 없는 유령 단락) 삭제
#     - text_words 전부 비어있고
#     - clip.assetIds 비어있거나 앞뒤 클립과 이미지 공유하는 경우만 안전하게 제거
def _get_image_tids(clip):
    tids = set()
    for aid in (clip.get('assetIds') or []):
        a = assets.get(aid, {})
        for tid in (a.get('trackIds') or []):
            t = tracks.get(tid, {})
            if t.get('type') in ('image', 'video'):
                tids.add(tid)
    return tids

to_delete = []
for i, c in enumerate(clips):
    words = c.get('words') or []
    text_words = [w for w in words if w.get('type') != 2]
    # 비어있는 조건: text_words 없거나(end marker만), 있어도 모두 공백
    is_empty = all(not (w.get('text') or '').strip() for w in text_words)
    # caption도 확인 (둘 다 비어야 삭제 대상)
    cap_text = ''
    for cap in (c.get('captions') or []):
        for item in (cap.get('text') or []):
            if (item.get('insert') or '').strip() and item.get('insert') != '\n':
                cap_text = item.get('insert')
                break
    if not is_empty or cap_text:
        continue
    own = _get_image_tids(c)
    prev_shared = i > 0 and bool(own & _get_image_tids(clips[i-1]))
    next_shared = i+1 < len(clips) and bool(own & _get_image_tids(clips[i+1]))
    # 안전 조건: 이미지가 없거나, 앞/뒤 중 하나와 공유 중
    if not own or prev_shared or next_shared:
        to_delete.append(i)

# 관련 asset/track 정리
for i in to_delete:
    c = clips[i]
    # clip 단위 assetIds 정리 (공유 이미지는 삭제 안 함)
    own_img = _get_image_tids(c)
    shared_with_others = set()
    for j, other in enumerate(clips):
        if j == i: continue
        shared_with_others |= _get_image_tids(other)
    exclusive = own_img - shared_with_others
    # exclusive 이미지는 어차피 없거나 공유된 경우만 삭제 대상이므로, 참조 제거만
    for aid in list(c.get('assetIds') or []):
        a = assets.get(aid, {})
        tids = a.get('trackIds') or []
        if any(t in exclusive for t in tids):
            # 단독 사용 이미지 → 삭제
            for t in tids:
                tracks.pop(t, None)
            assets.pop(aid, None)
    # word 단위 dummy ttsClip 삭제
    for w in (c.get('words') or []):
        for aid in (w.get('assetIds') or []):
            a = assets.get(aid, {})
            for tid in (a.get('trackIds') or []):
                t = tracks.get(tid, {})
                if t.get('type') in ('ttsClip', 'ttsDubbing'):
                    tracks.pop(tid, None)
            assets.pop(aid, None)

# 클립 제거 (뒤에서부터 삭제해야 인덱스 보존)
for i in reversed(to_delete):
    del clips[i]
    fixed += 1

# 4) ttsClipInfosMap 특수문자 정리 (원문 유지, 따옴표/괄호만 제거)
for mid, info in (pj['props'].get('ttsClipInfosMap') or {}).items():
    if not isinstance(info, dict): continue
    tx = info.get('text')
    if isinstance(tx, dict):
        for k in ('raw','processed'):
            if k in tx:
                cleaned = tts_clean(tx[k])
                if cleaned != tx[k]:
                    tx[k] = cleaned
                    fixed += 1

if fixed == 0:
    print('0')
    sys.exit(0)
with zipfile.ZipFile(out, 'w', zipfile.ZIP_STORED) as zo:
    zo.writestr('project.json', json.dumps(pj, ensure_ascii=False))
    for fn, data in media.items():
        zo.writestr(fn, data)
print(str(fixed))
