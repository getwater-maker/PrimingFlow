"""
Vrew ZIP 패키저 — Node.js에서 호출
사용: python vrew-maker.py <작업폴더> <출력.vrew>
작업폴더에 project.json + media/ 폴더 필요
"""
import zipfile, sys, os

work_dir = sys.argv[1]
out_path = sys.argv[2]

with zipfile.ZipFile(out_path, 'w', zipfile.ZIP_STORED) as zf:
    pj_path = os.path.join(work_dir, 'project.json')
    zf.write(pj_path, 'project.json')

    media_dir = os.path.join(work_dir, 'media')
    if os.path.exists(media_dir):
        for fn in sorted(os.listdir(media_dir)):
            zf.write(os.path.join(media_dir, fn), 'media/' + fn)

print('OK:' + str(os.path.getsize(out_path)))
