"""生成 README 用的合成示例工程（docs/demo-project.json）。

刻意不来自任何真实工程：工程名、轨道名、片段名、音符全是这里写死的。
用途：README 截图 / run.bat 默认打开 / 新克隆的人不用真工程也能把界面跑起来。
"""
from __future__ import annotations

import json
from pathlib import Path

PPQ = 480
BAR = PPQ * 4                     # 4/4 一小节
BARS = 10
OUT = Path(__file__).resolve().parent.parent / "docs" / "demo-project.json"


def notes(chords, clip_start, step=BAR // 2, length=BAR // 2 - 60, vel=96):
    """把和弦列表铺成音符：每 half-bar 一个和弦，三音同时按。"""
    out = []
    for i, chord in enumerate(chords):
        t = clip_start + i * step
        for k, pitch in enumerate(chord):
            out.append({
                "startTick": t,
                "lengthTick": length,
                "pitch": pitch,
                "velocity": max(40, vel - k * 6),
            })
    return out


# Cm - Ab - Eb - Bb 四个和弦（三个转位，听起来顺一点）
PROG = [[48, 55, 63], [44, 51, 60], [51, 58, 63], [46, 53, 58]]

piano_clips = []
for i in range(5):
    start = i * 2 * BAR
    piano_clips.append({
        "id": f"c{i}",
        "name": f"和弦 {i + 1}",
        "kind": "midi",
        "startTick": start,
        "lengthTick": 2 * BAR,
        "notes": notes(PROG, start),
        "audioFile": None,
    })

bass_clips = []
for i in range(3):
    start = i * 4 * BAR if i < 2 else 8 * BAR
    length = 4 * BAR if i < 2 else 2 * BAR
    seq = [36, 36, 32, 32, 39, 39, 34, 34]           # 根音走八分
    bass_clips.append({
        "id": f"b{i}",
        "name": f"贝斯 {i + 1}",
        "kind": "midi",
        "startTick": start,
        "lengthTick": length,
        "notes": [{"startTick": start + j * (BAR // 2), "lengthTick": BAR // 2 - 40,
                   "pitch": p, "velocity": 104} for j, p in enumerate(seq)],
        "audioFile": None,
    })

drums = [{
    "id": f"d{i}", "name": f"鼓组循环 {i + 1}", "kind": "audio",
    "startTick": i * 2 * BAR, "lengthTick": 2 * BAR,
    "notes": [], "audioFile": "drums_loop.wav",
} for i in range(5)]

synth_auto = [{
    "id": f"a{i}", "name": name, "kind": "automation",
    "startTick": i * 2 * BAR, "lengthTick": 2 * BAR,
    "notes": [], "audioFile": None,
} for i, name in enumerate(["滤波器截止", "混响干湿", "音高微调", "滤波器截止", "音量包络"])]

vocal = [{
    "id": f"v{i}", "name": f"人声 {i + 1}", "kind": "audio",
    "startTick": (2 + i * 4) * BAR, "lengthTick": 4 * BAR,
    "notes": [], "audioFile": f"vocal_take{i + 1}.wav",
} for i in range(2)]

tracks = [
    {"id": "t0", "name": "钢琴", "kind": "midi", "clips": piano_clips},
    {"id": "t1", "name": "合成器", "kind": "instrument", "clips": synth_auto},
    {"id": "t2", "name": "贝斯", "kind": "midi", "clips": bass_clips},
    {"id": "t3", "name": "鼓组", "kind": "audio", "clips": drums},
    {"id": "t4", "name": "人声", "kind": "audio", "clips": vocal},
]

payload = {
    "meta": {
        "host": "demo",
        "hostVersion": "1.0",
        "projectName": "dawview 示例工程",
        "bpm": 120.0,
        "timeSig": [4, 4],
        "ppq": PPQ,
        "sampleRate": 48000,
    },
    "tempoMap": [[0, 120.0]],
    "markers": [[0, "前奏"], [4 * BAR, "主歌"], [8 * BAR, "副歌"]],
    "tracks": tracks,
    "lengthTicks": BARS * BAR,
    "warnings": ["这是一份手写的合成示例数据，不对应任何真实工程"],
}

OUT.write_text(json.dumps(payload, ensure_ascii=False, indent=1), encoding="utf-8")
n_notes = sum(len(c["notes"]) for t in tracks for c in t["clips"])
n_clips = sum(len(t["clips"]) for t in tracks)
print(f"{OUT.name}: {len(tracks)} 轨道 / {n_clips} 片段 / {n_notes} 音符 / "
      f"{OUT.stat().st_size} 字节")
