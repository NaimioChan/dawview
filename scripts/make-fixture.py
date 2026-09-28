"""从真实工程里裁一份前端验证用的快照。

为什么是"裁"：真工程动辄几千个片段，前端验证只需要"每种片段/轨道类型各来几条"，
裁完体积小、断言也稳定。快照不进仓库（里面有工程名/轨道名），
要跑前端验证就自己生成一份：

    python scripts/make-fixture.py "我的工程.cpr"      # -> scripts/fixture-project.json
    python scripts/make-fixture.py "我的工程.flp"      # -> scripts/fixture-project-fl.json
    python scripts/make-fixture.py "我的工程.bwproject" # -> scripts/fixture-project-bitwig.json
    python scripts/make-fixture.py "我的工程.rpp"      # -> scripts/fixture-project-reaper.json

文件名默认按扩展名定（`scripts/verify.mjs` 就按这几个名字找），要别的名字用 --out：

    python scripts/make-fixture.py "变速工程.cpr" --out scripts/fixture-project-tempo.json
    node scripts/verify.mjs --tempo-fixture scripts/fixture-project-tempo.json

（速度轨那一段只有真·变速工程才验得出，所以单独一份快照、单独一个开关。）
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
OUT_NAME = {".cpr": "fixture-project.json", ".flp": "fixture-project-fl.json",
            ".rpp": "fixture-project-reaper.json",
            ".bwproject": "fixture-project-bitwig.json"}


def main() -> int:
    argv = sys.argv[1:]
    out_override = None
    if "--out" in argv:
        i = argv.index("--out")
        if i + 1 >= len(argv):
            print("--out 后面要跟路径", file=sys.stderr)
            return 2
        out_override = Path(argv[i + 1])
        del argv[i:i + 2]
    if not argv:
        print(__doc__.strip(), file=sys.stderr)
        return 2
    src = Path(argv[0])
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

    out = out_override if out_override else (ROOT / "scripts" / OUT_NAME[suffix])
    out.parent.mkdir(parents=True, exist_ok=True)
    out.write_text(json.dumps(project, ensure_ascii=False), encoding="utf-8")
    clips = sum(len(t["clips"]) for t in tracks)
    notes = sum(len(c["notes"]) for t in tracks for c in t["clips"])
    print(f"{out.name}: {len(tracks)} 轨道 / {clips} 片段 / {notes} 音符 / "
          f"{out.stat().st_size} 字节（来源 {src.name}，{picked}）")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
