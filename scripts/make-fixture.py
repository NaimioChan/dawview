"""从真实工程里裁一份前端验证用的快照。

为什么是"裁"：真工程动辄几千个片段，前端验证只需要"每种片段/轨道类型各来几条"，
裁完体积小、断言也稳定。快照不进仓库（里面有工程名/轨道名），
要跑前端验证就自己生成一份：

    python scripts/make-fixture.py "我的工程.cpr"      # -> scripts/fixture-project.json
    python scripts/make-fixture.py "我的工程.flp"      # -> scripts/fixture-project-fl.json

文件名是固定的（`scripts/verify.mjs` 就按这两个名字找），别改名。
"""
from __future__ import annotations

import json
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))

from dawview.app import PARSERS  # noqa: E402

PER_KIND = 3          # 每种轨道类型留几条
MAX_CLIPS = 6         # 每条轨道最多留几个片段
OUT_NAME = {".cpr": "fixture-project.json", ".flp": "fixture-project-fl.json"}


def main() -> int:
    if len(sys.argv) < 2:
        print(__doc__.strip(), file=sys.stderr)
        return 2
    src = Path(sys.argv[1])
    if not src.exists():
        print(f"找不到工程文件：{src}", file=sys.stderr)
        return 1
    suffix = src.suffix.lower()
    parser = PARSERS.get(suffix)
    if parser is None:
        print(f"暂不支持 {suffix}（支持：{', '.join(sorted(PARSERS))}）", file=sys.stderr)
        return 1

    project = parser(src).to_dict()

    picked: dict[str, int] = {}
    tracks = []
    for t in project["tracks"]:
        kind = t["kind"]
        if picked.get(kind, 0) >= PER_KIND:
            continue
        picked[kind] = picked.get(kind, 0) + 1
        t = dict(t, clips=t["clips"][:MAX_CLIPS])
        t["id"] = f"t{len(tracks)}"
        tracks.append(t)

    project["tracks"] = tracks
    project["warnings"] = []
    end = max((c["startTick"] + c["lengthTick"] for t in tracks for c in t["clips"]),
              default=0.0)
    project["lengthTicks"] = end + 4 * project["meta"]["ppq"]

    out = ROOT / "scripts" / OUT_NAME[suffix]
    out.write_text(json.dumps(project, ensure_ascii=False), encoding="utf-8")
    clips = sum(len(t["clips"]) for t in tracks)
    notes = sum(len(c["notes"]) for t in tracks for c in t["clips"])
    print(f"{out.name}: {len(tracks)} 轨道 / {clips} 片段 / {notes} 音符 / "
          f"{out.stat().st_size} 字节（来源 {src.name}，{picked}）")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
