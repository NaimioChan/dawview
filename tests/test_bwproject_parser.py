"""Bitwig `.bwproject` 解析器测试。

两段（跟 Cubase / FL / REAPER 那三份同构）：
1. 合成工程（总能跑）—— 按逆向出来的线格式手搓一份最小 `.bwproject`：
   容器头 + meta 块（含嵌入的摘要文档）+ 主文档（片段 / 音符轨 / 音符 / 音频片段
   + 样本记录）。覆盖两个容易踩的点：**元素头的"增量写法"**（头标记与 tag 全是 0、
   只有 class 摆在同一位置）和**元素内部也会出现 6 字节头标记**（字段 0x1fd 是列表
   分隔符），后者一度让字段流提前断掉。
2. 真实工程（文件在才跑）—— projects/25.6.30 house.bwproject 是 ground truth：
   124 BPM（文件名里就写着 124BPM）/ 31 轨 / 11 个 MIDI 片段 / 2502 个音符 /
   16 个音频片段，且音频轨名与音频文件名逐条对得上。
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
    """"Guitar"（乐器轨，1 片段 2 音符 / 2 条音高轨）+ "Drums"（音频轨，2 音频片段）。"""
    summary = summary_doc([(0x288, "Guitar"), (0x287, "Drums")])

    meta = u32(4) + u32(4) + b"meta"
    for key, payload in ((b"application_version_name", field(0, 0x08, u32(6) + b"5.3.13")),
                         (b"creator", field(0, 0x08, u32(6) + b"Naimio")),
                         (b"structure", field(0, 0x0D, u32(len(summary)) + summary))):
        meta += u32(1) + u32(len(key)) + key + payload[4:]   # payload[4:] = tag + 负载
    meta += u32(0)

    body = fstr(0x44, "合成工程")                           # 工程名（字段 0x44）
    body += fstr(0x2BD, "TEMPO") + ff64(0x2C8, 128.0)        # 速度对象

    # --- MIDI 片段（乐器轨 1）：片段名写在元素头之前 ---
    body += fstr(0x236, "Verse")
    body += elem(0x47, 0x21F, ff64(0x2AF, 4.0) + ff64(0x26, 8.0) + fu8(0x10F8, 0))
    # --- 音高轨 1（音高 60）：两条音符，第二条用"增量"元素头 ---
    body += elem(0x42, 0x18CB, b"")
    body += elem(0x66, 0x21F, ff64(0x2AF, 0.0) + ff64(0x26, 0.5) + fu8(0x10F8, 0)
                 + u32(0) + ff64(0xEF, 1.0))
    body += elem(0x66, 0x21F, ff64(0x2AF, 1.0) + ff64(0x26, 0.25) + fu8(0x10F8, 0)
                 + u32(0) + ff64(0xEF, 0.5), incremental=True)
    body += fu8(0xEE, 60)                                   # 音高轨的音高（在音符之后）
    # --- 音高轨 2（音高 67）：一条音符 ---
    body += elem(0x42, 0x18CB, b"")
    body += elem(0x66, 0x21F, ff64(0x2AF, 2.0) + ff64(0x26, 1.0) + fu8(0x10F8, 0)
                 + u32(0) + ff64(0xEF, 0.75))
    body += fu8(0xEE, 67)
    # --- 音频片段（音频轨 1）+ 它后面的样本记录（文件名）---
    body += elem(0xEE, 0x21F, ff64(0x2AF, 16.0) + ff64(0x26, 4.0) + fu8(0x10F8, 0))
    body += elem(0x43, 0x21F, ff64(0x2AF, 0.0) + ff64(0xA6, 0.0))     # 端点标记（不进契约）
    body += elem(0xD4, 0x21F, ff64(0x2AF, 0.0) + ff64(0x26, 4.0) + fu8(0x10F8, 0)
                 + fstr(0x129F, "kick.wav") + fstr(0x512, "kick.wav"))
    body += elem(0xEE, 0x21F, ff64(0x2AF, 24.0) + ff64(0x26, 2.0) + fu8(0x10F8, 0))
    body += elem(0xD4, 0x21F, ff64(0x2AF, 0.0) + ff64(0x26, 2.0) + fu8(0x10F8, 0)
                 + fstr(0x129F, "snare.wav") + fstr(0x512, "snare.wav"))

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
    assert kinds == [("Guitar", "instrument"), ("Drums", "audio")]
    assert all(t["name"] != "Project" for t in synth["tracks"])   # 工程根不算轨道


def test_synth_midi_clip_and_notes(synth):
    track = synth["tracks"][0]
    assert len(track["clips"]) == 1
    clip = track["clips"][0]
    assert clip["name"] == "Verse"
    assert clip["kind"] == "midi"
    assert clip["startTick"] == 4.0 * 480          # 拍 → tick
    assert clip["lengthTick"] == 8.0 * 480
    notes = clip["notes"]
    assert [(n["startTick"], n["lengthTick"], n["pitch"]) for n in notes] == [
        (0.0, 240.0, 60), (480.0, 120.0, 60), (960.0, 480.0, 67)]
    assert [n["velocity"] for n in notes] == [127, 64, 95]        # 0..1 → 1..127


def test_synth_audio_clips(synth):
    track = synth["tracks"][1]
    names = [(c["startTick"], c["audioFile"]) for c in track["clips"]]
    # 文件名跟轨道名对不上，两段都按文档顺序落在唯一那条音频轨上（一段都不丢）
    assert names == [(16.0 * 480, "kick.wav"), (24.0 * 480, "snare.wav")]
    assert all(c["kind"] == "audio" and c["notes"] == [] for c in track["clips"])


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
    assert kinds.count("instrument") == 11
    assert kinds.count("audio") == 16
    assert kinds.count("bus") == 4                 # 3 条 FX 轨 + Master
    assert tracks[0]["name"] == "Ample Guitar SJ"
    assert tracks[-1]["name"] == "Master"

    midi = [t for t in tracks if t["kind"] == "instrument"]
    assert all(len(t["clips"]) == 1 for t in midi)          # 每个乐器轨一个片段
    notes = [n for t in midi for c in t["clips"] for n in c["notes"]]
    assert len(notes) == 2502
    assert all(0 <= n["pitch"] <= 127 and 1 <= n["velocity"] <= 127 for n in notes)
    assert len({n["pitch"] for n in notes}) > 5             # 音高不是兜底值
    # 音符位置基本落在 1/32 网格上：实测 2502 个里只有 9 个是离网格的
    # （6 个 -1/8 拍的负起点 + 吉他轨上 3 个手拖过的小数起点）
    off_grid = [n for n in notes if abs(n["startTick"] % 60.0) > 1e-6]
    assert len(off_grid) <= 12, off_grid

    # 音频轨与音频文件名：16 条音频轨逐条对上（Bitwig 用拖进来的采样名给轨道命名），
    # 只有第一条轨的名字跟它的采样不同名（用户自己改过），所以单独点名核对。
    by_name = {t["name"]: t["clips"][0]["audioFile"] for t in tracks
               if t["kind"] == "audio" and t["clips"]}
    assert len(by_name) == 16
    assert by_name["KSHMR Crash 02"] == "KSHMR Crash 02.wav"
    assert by_name["KSHMR Acoustic Fill 128BPM 10"] == "KSHMR Acoustic Fill 128BPM 10.wav"
    assert by_name["KSHMR_Acoustic_Hat_Loop_13_120"] == "KSHMR_Acoustic_Hat_Loop_13_120.wav"
    assert by_name["DS_SPP2_kick_one_shot_acoustic_optimized"] == "KSHMR Acoustic Kick 12 - Hard.wav"
    assert r["lengthTicks"] == 84480.0
