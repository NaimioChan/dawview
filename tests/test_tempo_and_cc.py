"""契约 v0.3 的测试：速度轨（阶梯变速）+ 力度 / CC 控制器。

三段：
1. 合成 FL 工程 —— 60 字节播放列表记录、模式片段裁剪、Tempo 自动化曲线；
2. 真工程（文件在才跑）—— projects/ 里那两个借来的工程就是 ground truth；
3. model 里的速度轨工具函数。

真工程的期望值是实测出来的，不是猜的：
- Cubase "Orchestra practice 1-03.cpr"：速度轨 1127 个变速点，
  按阶梯积分到最后一个点 = 152.8672 s，正好等于文件里最后一条速度记录的
  绝对秒数（探针 probe_cpr_semantics.py 验过）—— 这就是阶梯语义的端到端证明。
- FL "piano practice 7.flp"：ID 156 = 135000 -> 135.000 BPM；
  Tempo 自动化曲线常驻值 0.625 按 60+120×value 还原 = 135.000 BPM，两者吻合。
"""
from __future__ import annotations

import struct
import sys
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from dawview.cpr_parser import parse_cpr          # noqa: E402
from dawview.flp_parser import parse_flp          # noqa: E402
from dawview.model import normalize_tempo_map, tempo_at   # noqa: E402

ROOT = Path(__file__).resolve().parent.parent
REAL_CPR = ROOT / "projects" / "Orchestra practice 1-03.cpr"
REAL_FLP = ROOT / "projects" / "piano practice 7.flp"


# ================================================================= 合成 FL 工程

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
    return (struct.pack("<IHHIHH", pos, 0, 1, length, key, 0)
            + bytes([0, 0, 0, 0, 0, vel, 0, 0]))


def _automation(points) -> bytes:
    """ID 234 曲线：points = [(位置增量(四分音符), 值 0..1), ...]。"""
    body = b"".join(struct.pack("<ddfI", d, v, 0.0, 1) for d, v in points)
    return (_u32(1) + _u32(64) + _u32(0) + _u32(3) + b"\x00"
            + _u32(len(points)) + body + bytes(112))


def _item60(pos: int, index: int, length: int, track: int,
            pattern_from: int | None = None, pattern_to: int | None = None,
            start_off: float = 0.0, end_off: float = 0.0) -> bytes:
    """60 字节播放列表记录（FL 24）。模式片段写 u32 裁剪区间，其余写 f32 偏移。"""
    head = struct.pack("<IHHIHH", pos, 20480, index, length, 499 - track, 0)
    head += bytes([0x40, 0x00, 0x40, 0x64, 0x80, 0x80])   # @16 实测常量
    head += struct.pack("<H", 64)                      # @22 flags
    if pattern_from is None:
        mid = struct.pack("<ff", start_off, end_off)
    else:
        mid = struct.pack("<II", pattern_from, pattern_to)
    return head + mid + _u32(1) + bytes(24)


def _build_flp60() -> bytes:
    """FL 24 形态：60 字节记录 + Tempo 自动化通道 + 被裁剪的模式片段。"""
    body = b"".join([
        _ev(199, b"24.1.1.4285"),
        _ev(156, _u32(135000)),                       # 工程速度 135.000 BPM
        _ev(33, b"\x04"), _ev(34, b"\x04"),

        # 通道 0：Tempo 自动化（内部名为空）
        _ev(64, _u16(0)), _ev(21, b"\x05"),
        _ev(201, _text("")), _ev(203, _text("Tempo")),
        _ev(234, _automation([(0.0, 0.625), (4.0, 0.25), (4.0, 0.625)])),

        # 模式 1：三个音符（0 / 96 / 192），裁剪区间取 [96, 96+768)
        _ev(65, _u16(1)), _ev(193, _text("Verse")),
        _ev(224, _note(0, 96, 60, 100) + _note(96, 96, 62, 90) + _note(192, 96, 64, 80)),

        _ev(233, b"".join([
            # 模式片段：只播模式里 [96, 864) 这一段（长度 768 = 区间长度）
            _item60(0, 20481, 768, 1, pattern_from=96, pattern_to=864),
            # Tempo 自动化片段：位置 0、长 768 tick = 8 个四分音符
            _item60(0, 0, 768, 0, start_off=0.0, end_off=8.0),
        ])),
        _ev(238, _u32(1) + bytes(66)), _ev(239, _text("Tempo")),
        _ev(238, _u32(2) + bytes(66)), _ev(239, _text("Piano")),
    ])
    header = b"FLhd" + _u32(6) + _u16(0) + _u16(2) + _u16(96)
    return header + b"FLdt" + _u32(len(body)) + body


@pytest.fixture(scope="module")
def synth60(tmp_path_factory):
    path = tmp_path_factory.mktemp("flp60") / "synth60.flp"
    path.write_bytes(_build_flp60())
    return parse_flp(path)


def test_playlist_record_size_autodetect(synth60):
    """60 字节记录要认出来（老写法硬编码 80 会读出 3 条垃圾）。"""
    clips = [c for t in synth60.tracks for c in t.clips]
    assert len(clips) == 2
    assert sorted(c.kind for c in clips) == ["automation", "midi"]


def test_pattern_clip_trim_shifts_notes(synth60):
    """模式片段只播 [96, 864)：第一个音符（0）该被裁掉，其余左移 96。"""
    midi = next(c for t in synth60.tracks for c in t.clips if c.kind == "midi")
    assert [(n.start_tick, n.pitch) for n in midi.notes] == [(0.0, 62), (96.0, 64)]


def test_tempo_automation_becomes_step_map(synth60):
    """曲线值 0.625 -> 135 BPM、0.25 -> 90 BPM；台阶按 1/16 拍加密。"""
    assert synth60.bpm == 135.0
    assert synth60.tempo_map[0] == [0.0, 135.0]
    bpms = {round(b, 3) for _t, b in synth60.tempo_map}
    assert 135.0 in bpms and 90.0 in bpms      # 曲线两端
    assert len(bpms) > 4                       # 斜坡被加密成一串台阶，不是一步跳
    # 从 135 线性降到 90 用了 4 个四分音符 -> 中间必须有台阶，不是一步跳
    mid = [b for t, b in synth60.tempo_map if 0 < t < 4 * 96]
    assert len(mid) >= 4
    assert all(90.0 < b < 135.0 for b in mid)
    # 降到 90 之后回到 135（曲线在同一个位置又给了一次 0.625）
    assert synth60.tempo_map[-1][1] == 135.0
    assert any("速度自动化" in w for w in synth60.warnings)


# =============================================================== 真工程（借来的）

@pytest.mark.skipif(not REAL_CPR.exists(), reason="borrowed Cubase project not available")
class TestRealCprTempo:
    @pytest.fixture(scope="class")
    def proj(self):
        return parse_cpr(REAL_CPR)

    def test_tempo_map(self, proj):
        # 1129 条速度记录、去掉同 tick 重复后 1127 个点
        assert len(proj.tempo_map) == 1127
        assert proj.tempo_map[0][0] == 0.0
        assert proj.tempo_map[0][1] == pytest.approx(115.0, abs=1e-3)   # f32 spq
        assert proj.bpm == pytest.approx(115.0, abs=1e-3)
        ticks = [t for t, _b in proj.tempo_map]
        assert ticks == sorted(ticks)
        assert all(5.0 <= b <= 999.0 for _t, b in proj.tempo_map)
        # 后半段才开始变速（前 31680 tick 是定速）
        assert ticks[2] == 31680.0
        assert len({round(b, 3) for _t, b in proj.tempo_map}) > 400

    def test_step_integral_matches_file(self, proj):
        """阶梯积分出来的总秒数必须等于文件里最后一条速度记录的绝对秒数。"""
        sec = 0.0
        for i in range(len(proj.tempo_map) - 1):
            t0, b0 = proj.tempo_map[i]
            t1, _ = proj.tempo_map[i + 1]
            sec += (t1 - t0) / proj.ppq * 60.0 / b0
        assert sec == pytest.approx(152.8672, abs=0.01)

    def test_velocity_is_the_real_byte(self, proj):
        notes = [n for t in proj.tracks for c in t.clips for n in c.notes]
        assert len(notes) == 4693
        vels = {n.velocity for n in notes}
        assert len(vels) > 50                     # 老写法（VffO）恒为 64
        assert min(vels) >= 1 and max(vels) <= 127

    def test_notes_belong_to_their_own_track(self, proj):
        """54 轨的交响工程：音符必须各归各轨，不能全塞进第一轨。

        旧写法只认第一个 'MMidiPart'，把全文件 4693 个音符都算给第一轨钢琴，
        其余 53 轨全空（用户报障）。音高范围是硬 ground truth：
        低音提琴 36..60、大提琴 39..67、小提琴 55..92、长笛 61..96。
        """
        by_name = {t.name: t for t in proj.tracks}
        assert len(proj.tracks) == 54
        with_notes = [t for t in proj.tracks if any(c.notes for c in t.clips)]
        assert len(with_notes) >= 25                    # 旧写法只有 1

        def rng(name):
            ns = [n.pitch for c in by_name[name].clips for n in c.notes]
            assert ns, f"{name} 应该有音符"
            return min(ns), max(ns)

        assert rng("Basses")[1] <= 62                   # 低音提琴：低
        assert rng("Cellos")[1] <= 70
        assert rng("Violins 1")[0] >= 50                # 小提琴：高
        assert rng("Flutes")[0] >= 55
        # 空的是混响/编组/总线，不是乐器轨
        empty = {t.name for t in proj.tracks if not t.clips}
        assert "Strings" in empty and "Stereo Out" in empty
        assert "Violins 1" not in empty and "Flutes" not in empty

    def test_track_kind_inferred_from_notes(self, proj):
        by_name = {t.name: t for t in proj.tracks}
        assert by_name["Violins 1"].kind == "midi"
        assert by_name["Timpani"].kind == "midi"

    def test_controllers(self, proj):
        clips = [c for t in proj.tracks for c in t.clips]
        allcc = {cc.cc for c in clips for cc in c.controllers}
        assert allcc == {1, 11, 64}
        names = {cc.cc: cc.name for c in clips for cc in c.controllers}
        assert names[1] == "调制轮" and names[11] == "表情" and names[64] == "延音踏板"
        # CC 点按 tick 落进哪个片段就归哪个（不重不漏）
        for want, total in ((1, 5271), (11, 2715)):
            got = sum(len(cc.points) for c in clips for cc in c.controllers if cc.cc == want)
            assert got == total
        for c in clips:
            for cc in c.controllers:
                ticks = [t for t, _v in cc.points]
                assert ticks == sorted(ticks)
                assert 0.0 <= ticks[0] and ticks[-1] <= c.length_tick
                assert all(0 <= v <= 127 for _t, v in cc.points)

    def test_contract_has_controllers(self, proj):
        d = proj.to_dict()
        clip = next(c for t in d["tracks"] for c in t["clips"] if c["notes"])
        cc = clip["controllers"][0]
        assert set(cc) == {"cc", "name", "points"}
        assert isinstance(cc["points"][0], list) and len(cc["points"][0]) == 2


@pytest.mark.skipif(not REAL_FLP.exists(), reason="borrowed FL project not available")
class TestRealFlpTempo:
    @pytest.fixture(scope="class")
    def proj(self):
        return parse_flp(REAL_FLP)

    def test_tempo(self, proj):
        assert proj.bpm == 135.0                  # ID 156 = 135000
        assert proj.ppq == 96
        assert proj.tempo_map[0] == [0.0, 135.0]
        # 149 点曲线加密成台阶；bpm 落在 FL 速度自动化片段的量程 60–180 内
        assert 500 <= len(proj.tempo_map) <= 2000
        assert all(60.0 <= b <= 180.0 for _t, b in proj.tempo_map)
        assert any("速度自动化" in w for w in proj.warnings)
        ticks = [t for t, _b in proj.tempo_map]
        assert ticks == sorted(ticks)

    def test_pattern_split_into_two_clips(self, proj):
        """同一模式被两个片段切成 [0,10368) / [10368,33432)，音符正好分完不重不漏。"""
        midi = [c for t in proj.tracks for c in t.clips if c.kind == "midi"]
        assert [(c.start_tick, c.length_tick) for c in midi] == [(0.0, 10368.0), (10512.0, 23064.0)]
        assert [len(c.notes) for c in midi] == [868, 1840]
        assert sum(len(c.notes) for c in midi) == 2708

    def test_clip_kinds_and_controllers(self, proj):
        clips = [c for t in proj.tracks for c in t.clips]
        assert sorted(c.kind for c in clips) == ["automation", "automation", "midi", "midi"]
        # FL 不存 MIDI CC
        assert all(c.controllers == [] for c in clips)


# =================================================================== 速度轨工具

def test_normalize_tempo_map_fills_zero():
    assert normalize_tempo_map([[480, 90.0]], 120.0) == [[0.0, 90.0], [480.0, 90.0]]
    assert normalize_tempo_map([], 100.0) == [[0.0, 100.0]]
    assert normalize_tempo_map([[0, 0.0], [10, 99999.0]], 120.0) == [[0.0, 5.0], [10.0, 999.0]]


def test_normalize_merges_same_tick():
    """加密采样点会落在同 tick 的 1e-9 邻居上 —— 合并后取最后一个。"""
    out = normalize_tempo_map([[100.000000001, 120.0], [100.0, 130.0]], 120.0)
    assert out == [[0.0, 130.0], [100.0, 130.0]]


def test_tempo_at_is_a_staircase():
    m = normalize_tempo_map([[0, 120.0], [480, 60.0], [960, 90.0]], 120.0)
    assert tempo_at(m, 0) == 120.0
    assert tempo_at(m, 479) == 120.0          # 保持到下一个点
    assert tempo_at(m, 480) == 60.0
    assert tempo_at(m, 10 ** 6) == 90.0
