"""Bitwig `.bwproject` 解析器测试。

两段（跟 Cubase / FL / REAPER 那三份同构）：
1. 合成工程（总能跑）—— 按逆向出来的线格式手搓一份最小 `.bwproject`：
   容器头 + meta 块（含嵌入的摘要文档）+ 主文档（轨道片段列表头 / 片段 / 音符轨 /
   音符 / 音频片段 / 样本记录）。覆盖三个容易踩的点：
   **(a)** 元素的"增量写法"（头标记与 tag 全是 0，只剩 class 摆在同一位置）；
   **(b)** 复制粘贴出来的片段：每一段都是**独立片段对象**，而且是**不带元素头标记**的
   紧凑写法（早期版本只认带头标记的片段，于是"每轨只剩一段"）；
   **(c)** 元素内部也会出现 6 字节头标记（字段 0x1fd 是列表分隔符）。
2. 真实工程（文件在才跑）—— projects/25.6.30 house.bwproject 是 ground truth：
   124 BPM / 31 轨 / **44 个 MIDI 片段 + 548 个音频片段**（用户把 8 小节循环复制粘贴了
   很多遍）/ **2363 个音符**（另有 139 个落在片段内容窗口之外，Bitwig 里不属于那些片段），
   且每条音频轨的片段名都是它自己的采样文件。
"""
from __future__ import annotations

import struct
import sys
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from dawview.bwproject_parser import parse_bwproject  # noqa: E402

ROOT = Path(__file__).resolve().parent.parent
REAL_BW = ROOT / "projects" / "25.6.30 house.bwproject"

HEADER_TAIL = bytes(28)          # 0x0e..0x2a 那段十六进制字段，解析器不看
MARKER = b"\x00\x00\x01\xfd\x01\x00"

OWNER_MIDI, OWNER_AUDIO = 0xBF, 0x105


# ------------------------------------------------------------------ 线格式小工具

def u32(v: int) -> bytes:
    return struct.pack(">I", v)


def f64(v: float) -> bytes:
    return struct.pack(">d", v)


def field(ident: int, tag: int, payload: bytes) -> bytes:
    return u32(ident) + bytes([tag]) + payload


def fstr(ident: int, text: str) -> bytes:
    raw = text.encode("utf-8")
    return field(ident, 0x08, u32(len(raw)) + raw)


def fu32(ident: int, val: int) -> bytes:
    return field(ident, 0x09, u32(val))


def ff64(ident: int, val: float) -> bytes:
    return field(ident, 0x07, f64(val))


def fu8(ident: int, val: int) -> bytes:
    return field(ident, 0x01, bytes([val]))


def elem(cls: int, ident: int, body: bytes, incremental: bool = False) -> bytes:
    """一个元素：头（6B 标记 + 字段号 + tag + class）或"增量"头（11 个 0 + class）。
    class 在两种写法里都落在元素起点 +11..+14。"""
    head = bytes(11) + u32(cls) if incremental \
        else MARKER + u32(ident) + bytes([0x12]) + u32(cls)
    return head + body


def bare_elem(cls: int, body: bytes) -> bytes:
    """紧凑元素头：没有 6B 头标记，只有 [u32 0][0x00][u32 class]（9 字节）。

    真实工程里复制粘贴出来的片段就是这种写法 —— 片段检测不能依赖头标记。
    """
    return u32(0) + bytes([0x00]) + u32(cls) + body


def clip_prologue(pos: float, length: float, owner: int) -> bytes:
    """片段字段区的固定开头：位置 + 时长 + 0x10f8 + (0x288, 宿主 class)。"""
    return ff64(0x2AF, pos) + ff64(0x26, length) + fu8(0x10F8, 0) + fu32(0x288, owner)


def clip_window(start: float, stop: float) -> bytes:
    """片段记录尾部的内容窗口：[起, 止] 两条子记录，各自后面跟一个 (0x2af, f64)。

    实测含义 = 这个片段显示 pattern 里的哪一段（pattern 坐标，单位拍）。
    音符位置是 pattern 坐标，显示位置 = 片段起点 + (音符位置 - 窗口起点)。
    """
    return (fu32(0x98C, 0x269) + ff64(0x2AF, start)
            + fu32(0x98D, 0x268) + ff64(0x2AF, stop))


def bw_doc(body: bytes, root_cls: int = 0x285) -> bytes:
    return b"BtWg" + b"0003000200" + HEADER_TAIL + b"\x0a" + u32(root_cls) + body


def summary_doc(tracks: list[tuple[int, str]], pad: int = 64) -> bytes:
    body = field(0xAD3, 0x08, u32(0)) + fu32(0xAD2, 0x283) + fstr(0xAD1, "Project")
    for k, (cls, name) in enumerate(tracks):
        if k == 0:
            body += field(0xACE, 0x12, u32(cls))          # 第一个对象带字段号
        else:
            body += u32(0) + u32(cls)                     # 其余走增量写法
        body += fstr(0xAD1, name)
    return bw_doc(body, 0x285) + b"\x00" * pad


def synth_project() -> bytes:
    """"Guitar"（乐器轨，2 个 MIDI 片段，第二段是复制粘贴的副本）
    + "Drums"（混合轨，2 个音频片段）+ "Master"（总线，没片段）。"""
    summary = summary_doc([(0x288, "Guitar"), (0x287, "Drums"), (0x28A, "Master")])

    meta = u32(4) + u32(4) + b"meta"
    for key, payload in ((b"application_version_name", field(0, 0x08, u32(6) + b"5.3.13")),
                         (b"creator", field(0, 0x08, u32(6) + b"Naimio")),
                         (b"structure", field(0, 0x0D, u32(len(summary)) + summary))):
        meta += u32(1) + u32(len(key)) + key + payload[4:]   # payload[4:] = tag + 负载
    meta += u32(0)

    body = fstr(0x44, "合成工程")                           # 工程名（字段 0x44）
    body += fstr(0x2BD, "TEMPO") + ff64(0x2C8, 128.0)        # 速度对象

    # --- 轨道 1（Guitar）的片段列表头 ---
    body += fu32(0x238, 0x52)
    # 片段 1：带完整元素头，名字写在片段自己的字段区里；**内容窗口起点是 -1 拍**
    # （片段长 8 拍、窗口 -1..7），三个音符是 pattern 坐标，所以要整体往后挪 1 拍
    body += elem(0x47, 0x21F, clip_prologue(4.0, 8.0, OWNER_MIDI) + fstr(0x236, "Verse")
                 + clip_window(-1.0, 7.0))
    body += elem(0x42, 0x18CB, b"")                          # 音高轨（音高 60）
    body += elem(0x66, 0x21F, ff64(0x2AF, 0.0) + ff64(0x26, 0.5) + fu8(0x10F8, 0)
                 + u32(0) + ff64(0xEF, 1.0))
    body += elem(0x66, 0x21F, ff64(0x2AF, 1.0) + ff64(0x26, 0.25) + fu8(0x10F8, 0)
                 + u32(0) + ff64(0xEF, 0.5), incremental=True)
    body += fu8(0xEE, 60)                                    # 音高轨的音高（在音符之后）
    body += elem(0x42, 0x18CB, b"")                          # 音高轨 2（音高 67）
    body += elem(0x66, 0x21F, ff64(0x2AF, 2.0) + ff64(0x26, 1.0) + fu8(0x10F8, 0)
                 + u32(0) + ff64(0xEF, 0.75))
    body += fu8(0xEE, 67)
    # 片段 2：**紧凑元素头**的副本（同一轨的第二段），没名字；窗口起点 0（不用挪），
    # 并且多带一个**窗口之外**的音符（pattern 6.0 拍，窗口只到 4 拍）—— 应当被丢掉
    body += bare_elem(0x47, clip_prologue(12.0, 4.0, OWNER_MIDI) + clip_window(0.0, 4.0))
    body += elem(0x42, 0x18CB, b"")
    body += elem(0x66, 0x21F, ff64(0x2AF, 0.5) + ff64(0x26, 0.5) + fu8(0x10F8, 0)
                 + u32(0) + ff64(0xEF, 0.5))
    body += elem(0x66, 0x21F, ff64(0x2AF, 6.0) + ff64(0x26, 0.5) + fu8(0x10F8, 0)
                 + u32(0) + ff64(0xEF, 0.5), incremental=True)
    body += fu8(0xEE, 55)
    # 片段 3：**没有窗口字段**的老写法 —— 退回"窗口起点 = 0"，只写 warning
    body += bare_elem(0x47, clip_prologue(20.0, 2.0, OWNER_MIDI))
    body += elem(0x42, 0x18CB, b"")
    body += elem(0x66, 0x21F, ff64(0x2AF, 0.5) + ff64(0x26, 0.5) + fu8(0x10F8, 0)
                 + u32(0) + ff64(0xEF, 0.5))
    body += fu8(0xEE, 62)

    # --- 轨道 2（Drums）的片段列表头 + 两个音频片段（各带自己的样本记录）---
    body += fu32(0x238, 0x53)
    body += elem(0xEE, 0x21F, clip_prologue(16.0, 4.0, OWNER_AUDIO))
    body += elem(0x43, 0x21F, ff64(0x2AF, 0.0) + ff64(0xA6, 0.0))     # 端点标记（不进契约）
    body += elem(0xD4, 0x21F, ff64(0x2AF, 0.0) + ff64(0x26, 4.0) + fu8(0x10F8, 0)
                 + fstr(0x129F, "kick.wav") + fstr(0x512, "kick.wav"))
    body += elem(0xEE, 0x21F, clip_prologue(24.0, 2.0, OWNER_AUDIO))
    body += elem(0xD4, 0x21F, ff64(0x2AF, 0.0) + ff64(0x26, 2.0) + fu8(0x10F8, 0)
                 + fstr(0x129F, "snare.wav") + fstr(0x512, "snare.wav"))

    # --- 轨道 3（Master）的片段列表头：没有片段 ---
    body += fu32(0x238, 0x54)

    return (b"BtWg" + b"0003000200" + HEADER_TAIL          # 容器头（42 字节）
            + meta + b" " * 16                            # meta 块 + 空格填充
            + b"\x0a" + u32(0x285) + body)                # 主文档体


@pytest.fixture(scope="module")
def synth(tmp_path_factory) -> dict:
    p = tmp_path_factory.mktemp("bw") / "synth.bwproject"
    p.write_bytes(synth_project())
    return parse_bwproject(p).to_dict()


# ------------------------------------------------------------------ 合成工程断言

def test_synth_meta(synth):
    m = synth["meta"]
    assert m["host"] == "bitwig"
    assert m["hostVersion"] == "5.3.13"
    assert m["projectName"] == "合成工程"          # 取自主文档字段 0x44
    assert m["bpm"] == 128.0                       # 取自 TEMPO 对象的 (0x2c8, f64)
    assert m["ppq"] == 480


def test_synth_tracks(synth):
    kinds = [(t["name"], t["kind"]) for t in synth["tracks"]]
    # 混合轨按实际内容定 kind（这里放的是音频片段 → audio），总线上没片段就保持 bus
    assert kinds == [("Guitar", "instrument"), ("Drums", "audio"), ("Master", "bus")]
    assert all(t["name"] != "Project" for t in synth["tracks"])   # 工程根不算轨道


def test_synth_midi_clips_and_notes(synth):
    """同一轨三段（第二/三段是复制粘贴出来的副本），三段都得在，音符各归各的。"""
    track = synth["tracks"][0]
    assert len(track["clips"]) == 3
    first, second, third = track["clips"]
    assert first["name"] == "Verse" and first["kind"] == "midi"
    assert first["startTick"] == 4.0 * 480          # 拍 → tick
    assert first["lengthTick"] == 8.0 * 480
    # 内容窗口起点 -1 拍 → 三个音符（pattern 坐标 0 / 1 / 2 拍）整体往后挪 1 拍
    assert [(n["startTick"], n["lengthTick"], n["pitch"]) for n in first["notes"]] == [
        (1.0 * 480, 240.0, 60), (2.0 * 480, 120.0, 60), (3.0 * 480, 480.0, 67)]
    assert [n["velocity"] for n in first["notes"]] == [127, 64, 95]   # 0..1 → 1..127

    assert second["name"] == ""                     # 副本没起名字
    assert second["startTick"] == 12.0 * 480
    assert second["lengthTick"] == 4.0 * 480
    # 窗口 0..4 拍：pattern 6.0 拍那个音符在窗口外（Bitwig 里不属于这一段）→ 丢掉
    assert [(n["startTick"], n["pitch"]) for n in second["notes"]] == [(240.0, 55)]

    assert third["name"] == "" and third["startTick"] == 20.0 * 480
    assert [(n["startTick"], n["pitch"]) for n in third["notes"]] == [(240.0, 62)]
    assert any("没读到内容窗口字段" in w for w in synth["warnings"])
    assert any("落在片段的内容窗口之外" in w for w in synth["warnings"])


def test_synth_audio_clips(synth):
    track = synth["tracks"][1]
    names = [(c["startTick"], c["audioFile"]) for c in track["clips"]]
    assert names == [(16.0 * 480, "kick.wav"), (24.0 * 480, "snare.wav")]
    assert all(c["kind"] == "audio" and c["notes"] == [] for c in track["clips"])
    assert synth["tracks"][2]["clips"] == []        # 总线上没片段


def test_synth_length_and_unknown_classes(synth):
    # 末尾片段结束在 (24+2) 拍，再加一小节余量
    assert synth["lengthTicks"] == 26.0 * 480 + 4 * 480
    # 合成工程里用的 class 全都认出来了（0x43 端点标记算已知，不进提示）
    assert not any("未认出的元素" in w for w in synth["warnings"])


def test_synth_no_crash_on_garbage(tmp_path):
    p = tmp_path / "bad.bwproject"
    p.write_bytes(b"nope" + bytes(64))
    with pytest.raises(ValueError):
        parse_bwproject(p)


# ------------------------------------------------------------------ 真实工程

@pytest.mark.skipif(not REAL_BW.exists(), reason="projects/ 里没有 Bitwig 工程（不入库）")
def test_real_project():
    r = parse_bwproject(REAL_BW).to_dict()
    m = r["meta"]
    assert m["host"] == "bitwig"
    assert m["hostVersion"] == "5.3.13"
    assert m["projectName"] == "25.6.30 house"
    assert m["bpm"] == 124.0                       # 工程名/素材名里都写着 124BPM
    assert m["ppq"] == 480

    tracks = r["tracks"]
    kinds = [t["kind"] for t in tracks]
    assert len(tracks) == 31
    assert kinds.count("instrument") == 11         # 11 条乐器轨（0x288）都有 MIDI 片段
    assert kinds.count("audio") == 16              # 4 条鼓组混合轨（只有音频片段）+ 12 条音频轨
    assert kinds.count("bus") == 4                 # 3 条 FX 轨 + Master
    assert tracks[0]["name"] == "Ample Guitar SJ"
    assert tracks[-1]["name"] == "Master"
    assert all(not t["clips"] for t in tracks if t["kind"] == "bus")   # 总线不放片段

    # --- 片段数量：复制粘贴出来的副本一段都不能少 ---
    clips = [c for t in tracks for c in t["clips"]]
    midi = [c for c in clips if c["kind"] == "midi"]
    audio = [c for c in clips if c["kind"] == "audio"]
    assert len(midi) == 44
    assert len(audio) == 548
    # 文档里的片段"组"是 11 个 MIDI 组 + 16 个音频组，组下标 ≠ 轨道下标（中间夹着 4 个
    # 空组 = FX 轨 / Master）。归轨靠"能放这种片段的轨道"顺序：乐器轨 11 条、混合轨 16 条。
    assert [len(t["clips"]) for t in tracks].count(0) == 4        # 只有 FX 轨 / Master 没片段
    assert all(c["kind"] == "audio" for t in tracks[11:15] for c in t["clips"])

    # 吉他轨：复制粘贴到 7 / 40 / 72 / 104 / 136 / 168 拍
    guitar = tracks[0]
    assert [c["startTick"] / 480 for c in guitar["clips"]] == [7.0, 40.0, 72.0, 104.0, 136.0, 168.0]

    notes = [n for c in midi for n in c["notes"]]
    assert len(notes) == 2363
    assert all(0 <= n["pitch"] <= 127 and 1 <= n["velocity"] <= 127 for n in notes)
    # 音高写在音高轨 footer 上（按"音符后面第一个 footer"取）：
    # 每个有音符的片段都得有一把真音高，不能被兜底成一条水平线
    # （1 拍长的小片段内容窗口只有 1 拍，里面本来就 3 个音符 → 不参与这条）
    for t in tracks:
        for c in t["clips"]:
            ps = [n["pitch"] for n in c["notes"]]
            if ps and c["lengthTick"] >= 4 * 480:
                assert len(set(ps)) >= 5, (t["name"], sorted(set(ps)))
    by_track = {t["name"]: [n["pitch"] for c in t["clips"] for n in c["notes"]] for t in tracks}
    assert min(by_track["Ample Guitar SJ"]) == 40                  # 吉他 40..96
    assert max(by_track["Ample Guitar SJ"]) <= 96
    assert len(set(by_track["Ample Guitar SJ"])) >= 12
    assert 36 <= min(by_track["Ample Guitar T"]) <= 40             # 吉他轨 37..75
    assert 70 <= max(by_track["Ample Guitar T"]) <= 78
    assert 36 <= min(by_track["Ample Bass J"]) <= 41               # 贝斯轨 39..58
    assert 55 <= max(by_track["Ample Bass J"]) <= 60
    assert 78 <= min(by_track["Pianoteq 6"]) <= 82                 # 钢琴 80..99
    # 4 条鼓组混合轨在 Bitwig 里只有音频片段（用户确认），MIDI 片段不该挂到它们身上
    for t in tracks[11:15]:
        assert not [n for c in t["clips"] for n in c["notes"]], t["name"]
    assert not any("没有音高轨 footer" in w for w in r["warnings"])
    # --- 片段内容窗口（0x98c/0x98d）：音符显示位置 = 片段起点 + (音符位置 - 窗口起点) ---
    # 吉他轨第一段（7..40 拍）窗口是 -1..32，比其他段宽 1 拍 —— 用户对着 Bitwig 看出来的
    # "整段音符往前挪了一拍" 就是它：按窗口起点 0 摆会整体差 1 拍
    assert any("落在片段的内容窗口之外" in w for w in r["warnings"])
    assert not any("没读到内容窗口字段" in w for w in r["warnings"])   # 44 段都读到了
    g0 = guitar["clips"][0]
    rel = sorted(n["startTick"] / 480 for n in g0["notes"])
    assert rel[0] == pytest.approx(0.875, abs=1e-6)      # 起拍前的装饰音
    assert (g0["startTick"] / 480) + rel[0] == pytest.approx(7.875, abs=1e-6)
    assert abs(rel[-1] - 32.875) < 1e-6
    # 窗口起点为 0 的段：音符相对位置不变（还是 pattern 坐标）
    assert min(n["startTick"] / 480 for n in guitar["clips"][1]["notes"]) == pytest.approx(0.0)
    # 吉他 T 轨那个 1 拍长的片段（135..136）窗口只有 1 拍 → 只剩窗口内的 3 个音符
    short = [c for c in tracks[1]["clips"] if c["lengthTick"] <= 480]
    assert [len(c["notes"]) for c in short] == [3]
    # 音符位置基本落在 1/32 网格上：实测 2363 个里 6 个是离网格的（用户手拖过的小数起点）
    off_grid = [n for n in notes if abs(n["startTick"] % 60.0) > 1e-6]
    assert len(off_grid) <= 12, off_grid

    # --- 音频片段：一条轨的片段都用同一个采样，采样名就是轨道名（Bitwig 拿拖进来的
    # 采样名给轨道命名）；4 条鼓组轨是"采样器重采样"，名字跟采样文件不同名，只查具体值。
    own = {t["name"]: {c["audioFile"] for c in t["clips"] if c["kind"] == "audio"}
           for t in tracks}
    for nm in ("KSHMR_Acoustic_Hat_Loop_13_120", "KSHMR_Acoustic_Ride_01", "KSHMR Crash 02",
               "KSHMR Crash 05", "KSHMR Funk Guitar 05 (104, D)", "KSHMR Acoustic Fill 128BPM 10",
               "KSHMR Trappy Hat Loop 07 - 130BPM", "KSHMR Shaker Loop 36 - 124BPM - Mixed",
               "Industrial Sound (6)", "KSHMR Top Loop 41 - 124BPM - No Clap",
               "Cymatics - FX Essentials White Noise Downlifter 9",
               "KSHMR Foley Drum Loop 37 - 124BPM - Tops"):
        assert own[nm] == {nm + ".wav"}, (nm, own[nm])
    assert own["DS_SPP2_kick_one_shot_acoustic_optimized"] == {"KSHMR Acoustic Kick 12 - Hard.wav"}
    assert own["KSHMR_Tambourine_02"] == {"KSHMR_Tambourine_01.wav"}
    assert own["VEH4 Shifted Clap Snare 035 -14ms"] == {"VEH4 Shifted Clap Snare 039 -42ms.wav"}
    assert own["NodeX_Snare_Clap_07"] == {"NodeX_Snare_Clap_02.wav"}
    counts = {t["name"]: len(t["clips"]) for t in tracks if t["kind"] == "audio"}
    assert counts["KSHMR_Acoustic_Hat_Loop_13_120"] == 16              # 帽子循环摆 16 遍
    assert counts["KSHMR Crash 02"] == 4                               # 4 次 crash
    assert counts["KSHMR Acoustic Fill 128BPM 10"] == 2                # 2 个 fill
    assert counts["DS_SPP2_kick_one_shot_acoustic_optimized"] == 151   # 4 条鼓组轨摆得最密
    assert counts["KSHMR_Tambourine_02"] == 63
    assert sum(counts.values()) == 548                                 # 16 条轨全在这里

    assert r["lengthTicks"] == 216.0 * 480
