"""Data model shared by all host parsers (docs/01-data-contract.md)."""
from __future__ import annotations

from dataclasses import dataclass, field


@dataclass
class Note:
    start_tick: float          # relative to clip start
    length_tick: float
    pitch: int                 # 0-127
    velocity: int              # 1-127

    def to_dict(self) -> dict:
        return {
            "startTick": self.start_tick,
            "lengthTick": self.length_tick,
            "pitch": self.pitch,
            "velocity": self.velocity,
        }


@dataclass
class Controller:
    """一条 MIDI CC 曲线（契约 v0.3 的 Controller）。"""
    cc: int                                    # 0-127
    points: list                               # [[tick_rel, value 0-127], ...] 按 tick 升序
    name: str = ""

    def to_dict(self) -> dict:
        return {
            "cc": self.cc,
            "name": self.name or f"CC{self.cc}",
            "points": self.points,
        }


@dataclass
class Clip:
    id: str
    name: str
    kind: str                  # midi | audio | automation | other
    start_tick: float          # absolute
    length_tick: float
    notes: list[Note] = field(default_factory=list)
    audio_file: str | None = None
    controllers: list[Controller] = field(default_factory=list)

    def to_dict(self) -> dict:
        return {
            "id": self.id,
            "name": self.name,
            "kind": self.kind,
            "startTick": self.start_tick,
            "lengthTick": self.length_tick,
            "notes": [n.to_dict() for n in self.notes],
            "controllers": [c.to_dict() for c in self.controllers],
            "audioFile": self.audio_file,
        }


@dataclass
class Track:
    id: str
    name: str
    kind: str                  # instrument | midi | audio | folder | bus | marker | tempo | other
    clips: list[Clip] = field(default_factory=list)

    def to_dict(self) -> dict:
        return {
            "id": self.id,
            "name": self.name,
            "kind": self.kind,
            "clips": [c.to_dict() for c in self.clips],
        }


@dataclass
class Project:
    name: str
    host: str
    host_version: str
    ppq: int = 480
    bpm: float = 120.0
    time_sig: tuple[int, int] = (4, 4)
    sample_rate: float = 44100.0
    length_ticks: float = 0.0
    tracks: list[Track] = field(default_factory=list)
    tempo_map: list = field(default_factory=list)
    markers: list = field(default_factory=list)
    warnings: list[str] = field(default_factory=list)

    def to_dict(self) -> dict:
        return {
            "meta": {
                "host": self.host,
                "hostVersion": self.host_version,
                "projectName": self.name,
                "bpm": self.bpm,
                "timeSig": list(self.time_sig),
                "ppq": self.ppq,
                "sampleRate": self.sample_rate,
            },
            "tempoMap": self.tempo_map,
            "markers": self.markers,
            "tracks": [t.to_dict() for t in self.tracks],
            "lengthTicks": self.length_ticks,
            "warnings": self.warnings,
        }


# ------------------------------------------------------------------ 速度轨

# 常用 CC 的中文名（钢琴窗下部的 CC 栏直接显示这个）—— 各宿主解析器共用
CC_NAMES = {
    1: "调制轮", 2: "呼吸", 4: "脚踏", 5: "滑音时间", 7: "音量", 8: "平衡",
    10: "声像", 11: "表情", 64: "延音踏板", 65: "滑音踏板", 66: "持音踏板",
    67: "弱音踏板", 68: "连奏踏板", 71: "共鸣", 74: "明亮度", 84: "滑音控制",
    91: "混响", 92: "颤音深度", 93: "合唱", 94: "颤音延迟", 95: "相位",
    121: "复位控制器", 123: "全部音符关",
}

BPM_MIN = 5.0
BPM_MAX = 999.0


def normalize_tempo_map(points, fallback_bpm: float) -> list:
    """把解析器拼出来的变速点整理成契约 v0.3 的形态。

    - 升序、tick 去重（同一个 tick 取**最后**一个，宿主后写的赢）
    - 首点补到 tick=0（工程开头必须有速度）
    - bpm 夹到 [5, 999]（宿主里的脏数据不至于把前端算成 0 或无穷）
    """
    clean: dict[float, float] = {}
    for tick, bpm in points or []:
        try:
            t = float(tick)
            b = float(bpm)
        except (TypeError, ValueError):
            continue
        if t < 0 or not (b == b):          # NaN 也不要
            continue
        # 加密采样点会落在同一个 tick 的 1e-9 邻居上 —— 按 1e-6 合并，
        # 同一个 tick 取最后写入的（宿主后写的赢）
        clean[round(t, 6)] = min(BPM_MAX, max(BPM_MIN, b))
    if not clean:
        return [[0.0, min(BPM_MAX, max(BPM_MIN, float(fallback_bpm or 120.0)))]]

    out = [[t, clean[t]] for t in sorted(clean)]
    if out[0][0] > 0:
        out.insert(0, [0.0, out[0][1]])
    return out


def tempo_at(tempo_map, tick: float) -> float:
    """阶梯语义取速度（前端同一套算法，这里给测试和 lengthTicks 用）。"""
    if not tempo_map:
        return 120.0
    bpm = tempo_map[0][1]
    for t, b in tempo_map:
        if t > tick:
            break
        bpm = b
    return bpm
