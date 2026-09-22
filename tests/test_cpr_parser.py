"""End-to-end parser tests against the real 26.9.16 Cubase project.

All expected values below are empirically verified against the project file
(Cubase 15.0.30 WIN64) — they are ground truth, not guesses.
"""
from __future__ import annotations

import sys
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from dawview.cpr_parser import parse_cpr  # noqa: E402

REAL_CPR = Path(r"D:\Users\Naimio\Documents\Projects\26.9.16\26.9.6 lulabi.cpr")

pytestmark = pytest.mark.skipif(
    not REAL_CPR.exists(), reason="sample Cubase project not available"
)


@pytest.fixture(scope="module")
def project():
    return parse_cpr(REAL_CPR)


def test_basic_meta(project):
    assert project.host == "cubase"
    assert project.host_version == "15.0.30"
    assert project.bpm == 76.0
    assert project.time_sig == (4, 4)
    assert project.ppq == 480


def test_tracks(project):
    names = [t.name for t in project.tracks]
    assert "Pianoteq 8 01" in names
    assert "未命名_lead" in names
    # de-duplicated: the piano track appears once, not twice
    assert names.count("Pianoteq 8 01") == 1
    piano = next(t for t in project.tracks if t.name == "Pianoteq 8 01")
    assert piano.kind == "instrument"
    lead = next(t for t in project.tracks if t.name == "未命名_lead")
    assert lead.kind == "audio"


def test_midi_clip(project):
    piano = next(t for t in project.tracks if t.name == "Pianoteq 8 01")
    assert len(piano.clips) == 1
    clip = piano.clips[0]
    assert clip.kind == "midi"
    assert clip.start_tick == 0.0
    assert 29000 <= clip.length_tick <= 31000  # 30202 observed


def test_notes(project):
    """192 note records; pitches inside the MIDI range; TDRH (quarters) -> ticks.

    旧写法用 [ -][ -] 卡 pitch/velocity 字节，velocity < 32 的
    弱奏音符会被漏掉（实测少 1 个）；现在只认属性袋标记，pitch/velocity 另做范围校验。
    """
    piano = next(t for t in project.tracks if t.name == "Pianoteq 8 01")
    notes = piano.clips[0].notes
    assert len(notes) == 192

    pitches = [n.pitch for n in notes]
    assert 21 <= min(pitches) and max(pitches) <= 108
    assert all(1 <= n.velocity <= 127 for n in notes)
    assert all(n.length_tick > 0 for n in notes)
    # TDRH is in quarter notes: 0.5 quarter = 240 ticks is the common case
    assert any(abs(n.length_tick - 240) < 40 for n in notes)

    starts = sorted(n.start_tick for n in notes)
    assert starts == [n.start_tick for n in notes]  # sorted
    assert starts[0] == 0.0
    assert max(starts) == 29520.0
    # chord: at least one duplicated onset
    assert len(starts) != len(set(starts))


def test_audio_clip(project):
    lead = next(t for t in project.tracks if t.name == "未命名_lead")
    assert len(lead.clips) == 1
    clip = lead.clips[0]
    assert clip.kind == "audio"
    # verified: start = 1231578.99 samples -> 15600.0 ticks; len = 14400 ticks
    assert clip.start_tick == 15600.0
    assert clip.length_tick == 14400.0


def test_contract_serialization(project):
    d = project.to_dict()
    assert d["meta"]["ppq"] == 480
    assert d["meta"]["bpm"] == 76.0
    assert d["meta"]["host"] == "cubase"
    assert d["meta"]["timeSig"] == [4, 4]

    piano = next(t for t in d["tracks"] if t["name"] == "Pianoteq 8 01")
    assert len(piano["clips"]) == 1
    clip = piano["clips"][0]
    assert clip["kind"] == "midi"
    assert len(clip["notes"]) == 192
    n0 = clip["notes"][0]
    assert set(n0) == {"startTick", "lengthTick", "pitch", "velocity"}

    assert d["lengthTicks"] > max(
        c["startTick"] + c["lengthTick"]
        for t in d["tracks"] for c in t["clips"]
    )
