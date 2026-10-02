"""MIDI `.mid` 解析器测试。

两段（跟 Cubase / FL / REAPER / Bitwig / Studio One 那五份同构）：
1. 合成文件（总能跑）—— 按线格式手搓字节，重点覆盖那些"文档说不清、只能靠实测"的地方：
   **(a)** 运行状态（状态字节省略，靠上一条继承）—— 实测真文件 64% 的事件走运行状态；
   **(b)** 力度 0 的 note-on 当 note-off；**(c)** 同音高叠加时按 `(通道, 音高)`
   先入先出配对；**(d)** 没收到的 note-off（块尾补齐）/ 配不到的 note-off（跳过）/
   长度为 0 的音符（按 1 tick）；**(e)** 走带块（只有 meta）不当轨道显示，
   **有名字没音符的空轨要保留成空行**；**(f)** 末尾超远 tick 上的速度点要丢掉
   （否则状态栏时长会被撑大）；**(g)** 格式 0 按通道拆轨；**(h)** SMPTE division
   重标到 480 ppq；**(i)** 块坏了只跳这一块，不拖垮整份文件。
2. 真实文件（文件在才跑）—— projects/Spring Mpnody.mid 是 ground truth：
   格式 1 / 39 条 MTrk / ppq 480 / 33 条内容轨 + 5 条空轨 + 1 条走带轨 /
   5346 个音符 / 214 个速度点 / 7 种 CC。里面还有一条"独立数据流对上同一个数"的
   定标证据：**逐字节自己走一遍 delta + 运行状态**，块长度、note-on 数、每种 CC 的点数
   必须和解析器给出的逐项相同（碰巧对上很难）。
"""
from __future__ import annotations

import collections
import struct
import sys
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from dawview.midi_parser import parse_midi  # noqa: E402

ROOT = Path(__file__).resolve().parent.parent
REAL_MIDI = ROOT / "projects" / "Spring Mpnody.mid"


# ------------------------------------------------------------------ 手搓 MIDI 字节

def v(value: int) -> bytes:
    """MIDI 变长量。"""
    out = bytearray([value & 0x7F])
    value >>= 7
    while value:
        out.insert(0, 0x80 | (value & 0x7F))
        value >>= 7
    return bytes(out)


def mtrk(body: bytes, extra: int = 0) -> bytes:
    """一个 MTrk 块；extra 用来故意把块长度写多几字节（坏块）。"""
    return b"MTrk" + struct.pack(">I", len(body) + extra) + body


def ev(delta: int, data: bytes) -> bytes:
    return v(delta) + data


def note_on(delta: int, channel: int, pitch: int, velocity: int) -> bytes:
    return ev(delta, bytes([0x90 | channel, pitch, velocity]))


def note_off(delta: int, channel: int, pitch: int) -> bytes:
    return ev(delta, bytes([0x80 | channel, pitch, 0]))


def cc(delta: int, channel: int, number: int, value: int) -> bytes:
    return ev(delta, bytes([0xB0 | channel, number, value]))


def meta(delta: int, mtype: int, body: bytes = b"") -> bytes:
    return ev(delta, bytes([0xFF, mtype]) + v(len(body)) + body)


def tempo(delta: int, bpm: float) -> bytes:
    return meta(delta, 0x51, int(round(60000000 / bpm)).to_bytes(3, "big"))


def track_name(delta: int, text: str) -> bytes:
    return meta(delta, 0x03, text.encode("utf-8"))


def time_sig(delta: int, numerator: int, denominator: int) -> bytes:
    power = {1: 0, 2: 1, 4: 2, 8: 3, 16: 4}[denominator]
    return meta(delta, 0x58, bytes([numerator, power, 24, 8]))


def marker(delta: int, text: str) -> bytes:
    return meta(delta, 0x06, text.encode("utf-8"))


def end(delta: int) -> bytes:
    return meta(delta, 0x2F)


def midi_file(fmt: int, division: int, chunks: list[bytes], extra_chunks=()) -> bytes:
    body = b"".join(chunks) + b"".join(extra_chunks)
    return b"MThd" + struct.pack(">IHHH", 6, fmt, len(chunks), division) + body


# 走带块：只有轨名 / 拍号 / 速度 / 标记，一个通道事件都没有
CONDUCTOR = mtrk(
    track_name(0, "合成曲子")
    + time_sig(0, 3, 4)
    + tempo(0, 120)
    + marker(480, "开始")
    + tempo(480, 240)
    + tempo(100000 - 960, 90)          # 远超内容末尾（内容到 2000 tick）→ 该被丢掉
    + end(0)
)

# 内容块：运行状态 / 力度 0 的 note-on / 同音高叠加 / 零长音符 / 悬空与散落 / CC
KEYS = mtrk(
    track_name(0, "Keys")
    + note_on(0, 0, 60, 100)
    + ev(0, bytes([0x3E, 100]))                        # 运行状态（继承 0x90）：音高 62
    + ev(240, bytes([0x40, 80]))                       # 运行状态：音高 64（tick 240）
    + note_off(240, 0, 60)                             # tick 480：关 60 → 长度 480
    + ev(0, bytes([0x3E, 0]))                          # 运行状态（继承 0x80）：关 62
    + ev(0, bytes([0x90, 0x40, 0x00]))                 # 力度 0 的 note-on = 关 64
    + note_on(0, 0, 60, 96)
    + note_on(0, 0, 60, 64)                            # 同音高叠两条：先入先出配对
    + note_off(240, 0, 60)                             # tick 720：关掉先开的那条（力度 96）
    + note_off(240, 0, 60)                             # tick 960：关掉后开的那条（力度 64）
    + note_on(0, 0, 65, 64) + note_off(0, 0, 65)       # 同 tick 开又关 → 按 1 tick
    + note_off(240, 0, 72)                             # tick 1200：没有对应的 note-on
    + cc(0, 0, 1, 20)                                  # tick 1200
    + cc(240, 0, 64, 127)                              # tick 1440，延音踏板
    + cc(23, 0, 11, 99)                                # tick 1463 —— 最后一条 CC
    + note_on(37, 0, 67, 70)                           # tick 1500，到块尾都没关
    + end(500)                                         # 结束在 tick 2000
)

EMPTY = mtrk(track_name(0, "空轨") + end(0))           # 有名字、没音符 → 保留成空行
BROKEN = mtrk(v(0) + bytes([0x90, 0x3C]))              # 事件被截断 → 整块跳过
JUNKY = mtrk(end(0) + b"\x01\x02")                     # 0x2F 之后还有非 0 字节 → 记账

SYNTH = midi_file(1, 480, [CONDUCTOR, KEYS, EMPTY, BROKEN, JUNKY],
                  extra_chunks=[b"JUNK" + struct.pack(">I", 4) + b"abcd"])


@pytest.fixture(scope="module")
def synth(tmp_path_factory) -> dict:
    path = tmp_path_factory.mktemp("midi") / "合成工程.mid"
    path.write_bytes(SYNTH)
    return parse_midi(path).to_dict()


# ------------------------------------------------------------------ 合成文件断言

def test_meta(synth):
    assert synth["meta"] == {
        "host": "midi",
        "hostVersion": "SMF 1",
        "projectName": "合成曲子",       # 走带块的轨名就是曲子名
        "bpm": 120.0,
        "timeSig": [3, 4],
        "ppq": 480,
        "sampleRate": 44100.0,          # MIDI 里没有采样率，给默认值
    }


def test_tempo_and_marker(synth):
    # 9 万多个 tick 之后那条速度点（90 BPM）落在内容之外，必须丢掉 ——
    # 留着会把状态栏的时长撑成十几分钟
    assert synth["tempoMap"] == [[0.0, 120.0], [960.0, 240.0]]
    assert synth["markers"] == [[480.0, "开始"]]
    assert any("速度点落在内容之后" in w for w in synth["warnings"])
    assert any("没有采样率" in w for w in synth["warnings"])


def test_tracks(synth):
    """走带块不当轨道；坏块跳过；有名字没音符的空轨保留。"""
    assert [t["name"] for t in synth["tracks"]] == ["Keys", "空轨"]
    assert [t["kind"] for t in synth["tracks"]] == ["midi", "midi"]
    assert synth["tracks"][1]["clips"] == []
    assert any("条只有速度 / 拍号 / 轨名的走带（元信息）块不作为轨道显示" in w
               for w in synth["warnings"])
    assert any("没有音符（只有轨名），按空行显示" in w for w in synth["warnings"])


def test_container_oddities(synth):
    """认不出的块跳过；坏块只跳自己；块长度对不上要记账。"""
    assert any("认不出的块「JUNK」" in w for w in synth["warnings"])
    assert any("事件流读不动" in w for w in synth["warnings"])
    assert any("字节的事件流对不上块长度" in w for w in synth["warnings"])
    # 坏块跳掉了，但别的块照常在
    assert len(synth["tracks"]) == 2


def test_notes(synth):
    """运行状态 / 力度 0 的 note-on / 同音高叠加的先入先出 / 零长 / 悬空。"""
    keys = synth["tracks"][0]
    assert len(keys["clips"]) == 1
    clip = keys["clips"][0]
    notes = [(n["pitch"], n["startTick"], n["lengthTick"], n["velocity"])
             for n in clip["notes"]]
    assert notes == [
        (60, 0, 480, 100),
        (62, 0, 480, 100),        # 运行状态认出来的那两条（同一个 tick 上）
        (64, 240, 240, 80),       # 运行状态：delta 240 之后落在 tick 240
        (60, 480, 240, 96),       # 同音高叠两条：先开的那条先被关掉（先入先出）
        (60, 480, 480, 64),
        (65, 960, 1, 64),         # 同 tick 开又关 → 1 tick
        (67, 1500, 500, 70),      # 没写 note-off → 按块尾（2000）补齐
    ]
    assert any("没写 note-off" in w for w in synth["warnings"])
    assert any("找不到对应的 note-on" in w for w in synth["warnings"])
    assert any("时长为 0" in w for w in synth["warnings"])
    # 音符不许露出片段
    for n in clip["notes"]:
        assert n["startTick"] >= 0
        assert n["startTick"] + n["lengthTick"] <= clip["lengthTick"] + 1e-6


def test_clip_span(synth):
    """片段从 0 铺到内容末尾：最晚的内容是补到块尾的那个音符（2000）。"""
    clip = synth["tracks"][0]["clips"][0]
    assert (clip["startTick"], clip["lengthTick"]) == (0.0, 2000.0)
    assert clip["kind"] == "midi" and clip["audioFile"] is None
    assert synth["lengthTicks"] == 2000 + 4 * 480


def test_controllers(synth):
    clip = synth["tracks"][0]["clips"][0]
    got = [(c["cc"], c["name"], c["points"]) for c in clip["controllers"]]
    assert got == [
        (1, "调制轮", [[1200, 20]]),
        (11, "表情", [[1463, 99]]),
        (64, "延音踏板", [[1440, 127]]),
    ]


# ------------------------------------------------------------------ 格式 0 / SMPTE

def test_format0_splits_channels(tmp_path):
    """格式 0：一个块里塞了全部通道 → 按通道拆成多条轨。"""
    block = mtrk(
        track_name(0, "单块")
        + tempo(0, 120)
        + note_on(0, 0, 60, 100) + note_off(480, 0, 60)
        + note_on(0, 1, 48, 90) + cc(0, 1, 7, 100) + note_off(960, 1, 48)
        + end(0)
    )
    path = tmp_path / "格式0.mid"
    path.write_bytes(midi_file(0, 96, [block]))
    out = parse_midi(path).to_dict()
    assert out["meta"]["ppq"] == 96                   # division 原样进契约
    assert out["meta"]["hostVersion"] == "SMF 0"
    assert [t["name"] for t in out["tracks"]] == ["单块 · 通道 1", "单块 · 通道 2"]
    assert [n["pitch"] for n in out["tracks"][0]["clips"][0]["notes"]] == [60]
    second = out["tracks"][1]["clips"][0]
    assert [n["pitch"] for n in second["notes"]] == [48]
    assert [c["cc"] for c in second["controllers"]] == [7]


def test_smpte_division(tmp_path):
    """SMPTE division：tick 是时间单位，按标称速度重标到 480 ppq 网格（秒数不变）。"""
    block = mtrk(track_name(0, "SMPTE") + tempo(0, 120)
                 + note_on(0, 0, 60, 100) + note_off(1000, 0, 60) + end(0))
    # 0xE7 28：高字节 0xE7 = -25（帧率 25），低字节 40 tick/帧 → 1000 tick/秒
    path = tmp_path / "smpte.mid"
    path.write_bytes(midi_file(0, 0xE728, [block]))
    out = parse_midi(path).to_dict()
    assert out["meta"]["ppq"] == 480
    # 1000 SMPTE tick = 1 秒 = 120 BPM 下 2 拍 = 960 tick
    assert out["tracks"][0]["clips"][0]["notes"][0]["lengthTick"] == 960
    assert any("SMPTE" in w for w in out["warnings"])


def test_bad_header(tmp_path):
    path = tmp_path / "坏文件.mid"
    path.write_bytes(b"RIFF" + b"\x00" * 40)
    with pytest.raises(ValueError):
        parse_midi(path)


# ------------------------------------------------------------------ 真实文件

needs_real = pytest.mark.skipif(not REAL_MIDI.exists(),
                                reason="projects/Spring Mpnody.mid 不在（真实文件段跳过）")


def _byte_scan(raw: bytes) -> dict:
    """独立扫描：自己走一遍 delta + 运行状态，只数数、不建模型。

    这条是"两条独立数据流对上同一个数"的定标证据 —— 它和解析器用的是同一批字节，
    但走的是另一套代码路径（这边只认结构、不做任何搬运），两边计数对不上就说明
    事件流理解错了。
    """
    fmt_and_division = struct.unpack_from(">HHH", raw, 8)
    division = fmt_and_division[2]
    pos, chunks = 8 + struct.unpack_from(">I", raw, 4)[0], []
    while pos + 8 <= len(raw):
        size = struct.unpack_from(">I", raw, pos + 4)[0]
        if raw[pos:pos + 4] == b"MTrk":
            chunks.append(raw[pos + 8:pos + 8 + size])
        pos += 8 + size

    note_ons, ccs, exact = 0, collections.Counter(), 0
    for payload in chunks:
        i, running = 0, -1                             # -1 = 还没有可继承的状态字节
        while i < len(payload):
            while True:                                # 变长量
                byte = payload[i]
                i += 1
                if not byte & 0x80:
                    break
            status = payload[i]
            if status < 0x80:
                assert running >= 0, "数据字节没有可继承的状态字节"
                status = running
            else:
                i += 1
                if status < 0xF0:
                    running = status
            if status == 0xFF:
                mtype = payload[i]
                i += 1
                length = 0
                while True:
                    byte = payload[i]
                    i += 1
                    length = (length << 7) | (byte & 0x7F)
                    if not byte & 0x80:
                        break
                i += length
                running = -1
                continue
            if status >= 0xF0:
                if status in (0xF0, 0xF7):
                    length = 0
                    while True:
                        byte = payload[i]
                        i += 1
                        length = (length << 7) | (byte & 0x7F)
                        if not byte & 0x80:
                            break
                    i += length
                else:
                    i += {0xF1: 1, 0xF2: 2, 0xF3: 1}.get(status, 0)
                running = -1
                continue
            high = status & 0xF0
            width = 2 if high in (0x80, 0x90, 0xA0, 0xB0, 0xE0) else 1
            first, second = payload[i], payload[i + 1] if width == 2 else 0
            i += width
            if high == 0x90 and second > 0:
                note_ons += 1
            elif high == 0xB0:
                ccs[first] += 1
        if i == len(payload):
            exact += 1
    return {"chunks": len(chunks), "exact": exact, "note_ons": note_ons,
            "ccs": dict(ccs), "division": division}


@pytest.fixture(scope="module")
def real() -> dict:
    return parse_midi(REAL_MIDI).to_dict()


@needs_real
def test_real_matches_byte_scan(real):
    """定标：独立扫描出来的块数 / note-on 数 / 每种 CC 的点数，逐项对上解析器。"""
    scan = _byte_scan(REAL_MIDI.read_bytes())
    assert scan["chunks"] == 39
    assert scan["exact"] == 39, "每个 MTrk 的事件流都该正好走满块长度"
    assert scan["division"] == 480
    clips = [c for t in real["tracks"] for c in t["clips"]]
    notes = [n for c in clips for n in c["notes"]]
    assert scan["note_ons"] == len(notes) == 5346
    got = collections.Counter()
    for clip in clips:
        for controller in clip["controllers"]:
            got[controller["cc"]] += len(controller["points"])
    assert dict(got) == scan["ccs"] == {1: 15911, 11: 682, 16: 641, 21: 636,
                                       22: 514, 58: 84, 64: 619}


@needs_real
def test_real_meta(real):
    assert real["meta"]["host"] == "midi"
    assert real["meta"]["hostVersion"] == "SMF 1"
    assert real["meta"]["projectName"] == "Spring Mpnody"    # 走带块的轨名
    assert real["meta"]["bpm"] == 136.0          # 微秒反算后按 1e-3 收敛（见解析器 docstring）
    assert real["meta"]["timeSig"] == [4, 4]
    assert real["meta"]["ppq"] == 480
    assert real["meta"]["sampleRate"] == 44100.0


@needs_real
def test_real_tracks(real):
    """39 条 MTrk = 33 条内容轨 + 5 条空轨 + 1 条走带块（不作为轨道）。"""
    assert len(real["tracks"]) == 38
    assert all(t["kind"] == "midi" for t in real["tracks"])
    assert [t["name"] for t in real["tracks"] if not t["clips"]] == [
        "Euphoniums", "Cimbassos", "Solo Contrabass Tuba", "Marimba", "Xylophone"]
    assert "Spring Mpnody" not in [t["name"] for t in real["tracks"]]
    # 整条轨一个片段：起点 0、长度到该轨最晚的内容
    for t in real["tracks"]:
        for clip in t["clips"]:
            assert clip["startTick"] == 0.0
            assert clip["lengthTick"] > 0
            assert clip["name"] == t["name"]
    assert any("走带（元信息）块不作为轨道显示" in w for w in real["warnings"])


@needs_real
def test_real_notes_and_tempo(real):
    clips = [c for t in real["tracks"] for c in t["clips"]]
    notes = [n for c in clips for n in c["notes"]]
    assert len(clips) == 33
    assert min(n["pitch"] for n in notes) == 31
    assert max(n["pitch"] for n in notes) == 99
    assert min(n["velocity"] for n in notes) == 1
    assert max(n["velocity"] for n in notes) == 127
    assert len({n["velocity"] for n in notes}) == 114      # 力度不是塌成一两档
    # 内容末尾 + 一小节
    end = max(c["startTick"] + c["lengthTick"] for c in clips)
    assert end == 264981.0
    assert real["lengthTicks"] == end + 4 * 480
    # 216 个速度点里有两处同 tick（取后写的）、末尾那个超远点被丢掉 → 214 个
    assert len(real["tempoMap"]) == 214
    assert real["tempoMap"][0] == [0.0, 136.0]
    assert real["tempoMap"][-1] == [243840.0, 120.0]
    assert max(p[0] for p in real["tempoMap"]) <= real["lengthTicks"]
    assert any("速度点落在内容之后" in w for w in real["warnings"])


@needs_real
def test_real_note_invariants(real):
    for track in real["tracks"]:
        for clip in track["clips"]:
            previous = -1.0
            for note in clip["notes"]:
                assert note["lengthTick"] > 0
                assert note["startTick"] >= 0
                assert note["startTick"] + note["lengthTick"] <= clip["lengthTick"] + 1e-6
                assert 0 <= note["pitch"] <= 127
                assert 1 <= note["velocity"] <= 127
                previous = note["startTick"]
            for controller in clip["controllers"]:
                ticks = [p[0] for p in controller["points"]]
                assert ticks == sorted(ticks)
                assert all(0 <= v <= 127 for _t, v in controller["points"])
