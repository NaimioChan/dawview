"""FL Studio .flp 解析器测试。

两段：
1. 合成工程（总能跑）—— 用 _build_flp() 手写一份最小 .flp，逐字段核对解析结果；
2. 真实工程（文件在才跑）—— 万古城.flp 的实测值就是 ground truth。

合成那段也顺手覆盖了 VarInt 长度（长通道名 > 127 字节 → 两字节长度）。
"""
from __future__ import annotations

import struct
import sys
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from dawview.flp_parser import parse_flp  # noqa: E402

REAL_FLP = Path(r"D:\Users\Naimio\Documents\Projects\26.9.15\万古城.flp")


# ------------------------------------------------------------------ 合成工程

def _varint(n: int) -> bytes:
    out = bytearray()
    while True:
        b = n & 0x7F
        n >>= 7
        if n:
            out.append(b | 0x80)
        else:
            out.append(b)
            return bytes(out)


def _ev(eid: int, payload: bytes = b"") -> bytes:
    """按事件 ID 区间决定长度写法（1/2/4 字节固定，或 VarInt 长度前缀）。"""
    if eid < 64:
        return bytes([eid]) + payload
    if eid < 128:
        return bytes([eid]) + payload
    if eid < 192:
        return bytes([eid]) + payload
    return bytes([eid]) + _varint(len(payload)) + payload


def _u16(v: int) -> bytes:
    return struct.pack("<H", v)


def _u32(v: int) -> bytes:
    return struct.pack("<I", v)


def _text(s: str) -> bytes:
    return s.encode("utf-16-le") + b"\x00\x00"


def _note(pos: int, length: int, key: int, vel: int) -> bytes:
    """24 字节音符记录（字段顺序见 flp_parser._parse_notes）。"""
    return (struct.pack("<IHHIHH", pos, 0, 1, length, key, 0)
            + bytes([0, 0, 0, 0, 0, vel, 0, 0]))


def _playlist_item(pos: int, index: int, length: int, track: int,
                   start_off: float = -1.0, end_off: float = -1.0) -> bytes:
    """80 字节播放列表记录；track 是正序轨道号（记录里存的是 499 - track）。

    字节数必须正好 80（16 头 + 2 + 2 + 4 + 8 + 4 + 44）——少一个字节后面全部错位。
    """
    return (struct.pack("<IHHIHH", pos, 20480, index, length, 499 - track, 0)
            + bytes([120, 0]) + struct.pack("<H", 64)
            + bytes([64, 100, 128, 128]) + struct.pack("<ff", start_off, end_off)
            + _u32(14075) + bytes(44))


def _build_flp() -> bytes:
    body = b"".join([
        _ev(199, b"25.2.4.5242"),                 # FLVersion（ASCII）
        _ev(33, b"\x04"), _ev(34, b"\x04"),       # 拍号 4/4
        _ev(148, _u32(0x08000000 | 768)), _ev(205, _text("4/4")),   # 时间标记

        # 通道 0：Sampler + 采样路径（长名字顺带覆盖 VarInt）
        _ev(64, _u16(0)), _ev(21, b"\x04"),
        _ev(203, _text("kick " + "x" * 200)),
        _ev(196, _text("%FLStudioUserData%\\Audio\\Rendered\\kick_1.wav")),
        # 通道 1：插件参数（自动化片段）
        _ev(64, _u16(1)), _ev(21, b"\x05"), _ev(203, _text("Serum - Cutoff")),
        # 通道 2：VST 乐器，被播放列表引用 → 归到 other
        _ev(64, _u16(2)), _ev(21, b"\x02"), _ev(203, _text("Serum")),

        # 模式 1：两个音符
        _ev(65, _u16(1)), _ev(193, _text("Verse")),
        _ev(224, _note(0, 96, 60, 100) + _note(144, 72, 64, 90)),

        # 播放列表：轨道 0 音频、轨道 1 自动化、轨道 2 模式片段、轨道 3 other
        _ev(233, b"".join([
            _playlist_item(0, 0, 768, 0, 0.0, 4000.0),      # 音频：4000ms/768tick -> 120 BPM
            _playlist_item(768, 1, 384, 1),                 # 自动化
            _playlist_item(384, 20481, 768, 2),             # 模式 1
            _playlist_item(1536, 2, 384, 3),                # 未识别通道 -> other
        ])),

        # 4 条轨道（238 起块，239 给名字）
        _ev(238, _u32(1) + bytes(66)), _ev(239, _text("drums")),
        _ev(238, _u32(2) + bytes(66)), _ev(239, _text("Serum - Cutoff")),
        _ev(238, _u32(3) + bytes(66)), _ev(239, _text("Verse")),
        _ev(238, _u32(4) + bytes(66)), _ev(239, _text("")),
    ])
    header = b"FLhd" + _u32(6) + _u16(0) + _u16(3) + _u16(96)
    return header + b"FLdt" + _u32(len(body)) + body


@pytest.fixture(scope="module")
def synth(tmp_path_factory):
    path = tmp_path_factory.mktemp("flp") / "synth.flp"
    path.write_bytes(_build_flp())
    return parse_flp(path)


def test_synth_meta(synth):
    assert synth.host == "fl"
    assert synth.host_version == "25.2.4.5242"
    assert synth.ppq == 96
    assert synth.time_sig == (4, 4)
    assert synth.markers == [[768, "4/4"]]
    # 4000 ms / 768 tick = 5.208333 ms/tick -> 120.000 BPM（ppq 96）
    assert synth.bpm == 120.0
    assert synth.tempo_map == [[0, 120.0]]
    assert any("采样率" in w for w in synth.warnings)


def test_synth_tracks_and_kinds(synth):
    assert [(t.name, t.kind) for t in synth.tracks] == [
        ("drums", "audio"), ("Serum - Cutoff", "automation"),
        ("Verse", "midi"), ("轨道 4", "other"),
    ]
    assert [c.kind for c in synth.tracks[0].clips] == ["audio"]
    assert [c.kind for c in synth.tracks[1].clips] == ["automation"]
    assert [c.kind for c in synth.tracks[2].clips] == ["midi"]
    assert [c.kind for c in synth.tracks[3].clips] == ["other"]


def test_synth_clip_fields(synth):
    audio = synth.tracks[0].clips[0]
    assert audio.name == "kick_1"                       # 采样文件主干名
    assert audio.audio_file.endswith("kick_1.wav")
    assert (audio.start_tick, audio.length_tick) == (0.0, 768.0)

    auto = synth.tracks[1].clips[0]
    assert auto.name == "Serum - Cutoff"
    assert auto.audio_file is None
    assert (auto.start_tick, auto.length_tick) == (768.0, 384.0)

    pat = synth.tracks[2].clips[0]
    assert pat.name == "Verse"
    assert pat.start_tick == 384.0
    assert [(n.start_tick, n.length_tick, n.pitch, n.velocity) for n in pat.notes] == [
        (0.0, 96.0, 60, 100), (144.0, 72.0, 64, 90),
    ]

    other = synth.tracks[3].clips[0]
    assert other.name == "Serum"                        # 只有通道名可用
    assert other.kind == "other"


def test_synth_length_and_contract(synth):
    end = max(c.start_tick + c.length_tick for t in synth.tracks for c in t.clips)
    assert synth.length_ticks == end + 4 * synth.ppq    # 尾巴留一小节
    d = synth.to_dict()
    assert d["meta"]["host"] == "fl"
    assert d["meta"]["ppq"] == 96
    assert set(d["tracks"][2]["clips"][0]["notes"][0]) == {
        "startTick", "lengthTick", "pitch", "velocity"}


def test_rejects_non_flp(tmp_path):
    bogus = tmp_path / "not.flp"
    bogus.write_bytes(b"RIFF....")
    with pytest.raises(ValueError):
        parse_flp(bogus)


# ------------------------------------------------------------------ 真实工程

# 标记不能打在 fixture 上（pytest 会直接报错），所以真实工程这几条放进一个类里，
# 用类级 skipif 一起管住：文件不在（换台机器）就整类跳过。
@pytest.fixture(scope="module")
def real():
    return parse_flp(REAL_FLP)


@pytest.mark.skipif(not REAL_FLP.exists(),
                    reason="sample FL Studio project not available")
class TestRealFlp:
    def test_real_meta(self, real):
        assert real.host == "fl"
        assert real.host_version == "25.2.4.5242"
        assert real.ppq == 96
        assert real.time_sig == (4, 4)
        assert real.bpm == 173.0      # 由音频片段 ms/tick 反推（见解析器 docstring）
        assert real.markers == [[768, "4/4"]]
        assert real.length_ticks == 58510.0

    def test_real_counts(self, real):
        d = real.to_dict()
        clips = [c for t in d["tracks"] for c in t["clips"]]
        notes = [n for c in clips for n in c["notes"]]
        assert len(d["tracks"]) == 167
        assert len(clips) == 3274
        assert len(notes) == 3591

        kinds: dict[str, int] = {}
        for c in clips:
            kinds[c["kind"]] = kinds.get(c["kind"], 0) + 1
        assert kinds == {"audio": 1755, "automation": 1418, "midi": 101}

        tkinds: dict[str, int] = {}
        for t in d["tracks"]:
            tkinds[t["kind"]] = tkinds.get(t["kind"], 0) + 1
        assert tkinds == {"automation": 72, "audio": 62, "midi": 29, "other": 4}

    def test_real_first_tracks(self, real):
        first = real.tracks[0]
        assert first.name == "Serum"
        assert first.kind == "midi"
        assert len(first.clips) == 5
        clip = first.clips[0]
        assert clip.kind == "midi"
        assert clip.start_tick == 768.0
        assert clip.length_tick == 12288.0
        assert len(clip.notes) == 41
        assert (clip.notes[0].start_tick, clip.notes[0].pitch) == (0.0, 86)

        auto = next(t for t in real.tracks if t.kind == "automation")
        assert auto.clips[0].kind == "automation"
        assert auto.clips[0].audio_file is None

    def test_real_audio_clip(self, real):
        audio = next(c for t in real.tracks for c in t.clips if c.kind == "audio")
        assert audio.audio_file and "Rendered" in audio.audio_file
        assert audio.name == Path(audio.audio_file.replace("\\", "/")).stem   # 名字 = 文件主干名
        assert audio.length_tick > 0

    def test_real_notes_in_range(self, real):
        notes = [n for t in real.tracks for c in t.clips for n in c.notes]
        assert all(0 <= n.pitch <= 127 for n in notes)
        assert all(1 <= n.velocity <= 127 for n in notes)
        assert all(n.length_tick > 0 for n in notes)
        # 音符位置相对片段起点，且按时间排好序
        for t in real.tracks:
            for c in t.clips:
                starts = [n.start_tick for n in c.notes]
                assert starts == sorted(starts)
