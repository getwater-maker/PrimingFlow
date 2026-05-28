#!/usr/bin/env python3
"""
PrimingFlow ComfyUI Pod — 모델 다운로드 헬퍼

PrimingFlow 워크플로 매니페스트(*.manifest.json) 의 models 배열을 읽어
HuggingFace 에서 자동 다운로드 후 ComfyUI 가 기대하는 경로로 symlink 연결.

영상의 권장 방식(HF cache + symlink)을 그대로 구현:
- HF_HOME 캐시에 실제 파일 저장 (Pod 재시동 시 빠른 복원)
- ComfyUI 의 models/ 하위에는 symlink 만 생성
- 이미 캐시에 있으면 다운로드 스킵 (resume_download=True 로 부분 다운로드도 이어받음)
"""

from __future__ import annotations

import json
import os
import sys
from pathlib import Path

try:
    from huggingface_hub import hf_hub_download
except ImportError:
    print("[!] huggingface_hub 미설치. pip install huggingface_hub", file=sys.stderr)
    sys.exit(2)


WORKFLOWS_DIR = Path(os.environ.get("WORKFLOWS_DIR", "/workspace/workflows"))
COMFY_BASE = Path(os.environ.get("COMFY_BASE", "/workspace/ComfyUI"))
HF_HOME = Path(os.environ.get("HF_HOME", "/workspace/hf-cache"))


def gather_specs() -> dict[tuple[str, str], dict]:
    """모든 매니페스트 파일에서 models 항목을 모아 (repo, filename) 키로 dedup."""
    out: dict[tuple[str, str], dict] = {}
    if not WORKFLOWS_DIR.is_dir():
        print(f"[!] 워크플로 디렉토리 없음: {WORKFLOWS_DIR}", file=sys.stderr)
        return out

    for path in sorted(WORKFLOWS_DIR.glob("*.manifest.json")):
        try:
            manifest = json.loads(path.read_text(encoding="utf-8"))
        except Exception as exc:  # noqa: BLE001
            print(f"[!] {path.name} 파싱 실패: {exc}")
            continue

        for spec in manifest.get("models", []):
            key = (spec["repo"], spec["filename"])
            out.setdefault(key, spec)
    return out


def ensure_symlink(target: Path, link: Path) -> None:
    """ComfyUI 가 기대하는 link 경로 → HF 캐시의 실제 target 으로 symlink."""
    link.parent.mkdir(parents=True, exist_ok=True)
    if link.is_symlink() or link.exists():
        # 이미 존재하면 그대로 둠 (덮어쓰기는 위험)
        return
    try:
        link.symlink_to(target)
    except OSError:
        # Windows 등에서 symlink 가 막힌 경우 hardlink 폴백
        try:
            os.link(target, link)
        except OSError:
            # 최후 — 복사
            import shutil

            shutil.copy2(target, link)


def download_one(spec: dict) -> bool:
    repo = spec["repo"]
    filename = spec["filename"]
    dest = COMFY_BASE / spec["destPath"]

    if dest.exists() or dest.is_symlink():
        print(f"  [skip] {dest.relative_to(COMFY_BASE)} 이미 존재")
        return True

    print(f"  [pull] {repo} :: {filename}  → {dest.relative_to(COMFY_BASE)}")
    try:
        local_path = hf_hub_download(
            repo_id=repo,
            filename=filename,
            cache_dir=str(HF_HOME),
            resume_download=True,
        )
    except Exception as exc:  # noqa: BLE001
        print(f"  [ERR ] {repo}/{filename}: {exc}")
        return False

    ensure_symlink(Path(local_path), dest)
    return True


def main() -> int:
    specs = gather_specs()
    if not specs:
        print("워크플로 매니페스트가 없거나 models 가 비어있음 — 다운로드 스킵.")
        return 0

    print(f"총 {len(specs)} 개 모델 확인...")
    HF_HOME.mkdir(parents=True, exist_ok=True)

    failed = 0
    for spec in specs.values():
        if not download_one(spec):
            failed += 1

    if failed:
        print(f"❌ {failed}/{len(specs)} 모델 실패")
        return 1
    print(f"✅ {len(specs)} 모델 준비 완료")
    return 0


if __name__ == "__main__":
    sys.exit(main())
