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
class Clip:
    id: str
    name: str
    kind: str                  # midi | audio
    start_tick: float          # absolute
    length_tick: float
    notes: list[Note] = field(default_factory=list)
    audio_file: str | None = None

    def to_dict(self) -> dict:
        return {
            "id": self.id,
            "name": self.name,
            "kind": self.kind,
            "startTick": self.start_tick,
            "lengthTick": self.length_tick,
            "notes": [n.to_dict() for n in self.notes],
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
