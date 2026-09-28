"""REAPER .rpp 解析器测试。

两段（与 FL 那份测试同构）：
1. 合成工程（总能跑）—— 手写一份最小 .rpp，逐字段核对；重点覆盖那些
   "文档说不清、只能靠实测"的地方：`e`/`E` 两种事件行、十六进制事件字节、
   增量偏移、六进制…（见下）以及跨变速点的秒->tick 积分；
2. 真实工程（文件在才跑）—— projects/dnb.rpp 是 ground truth：
   190 BPM / ppq 960 / 19 轨 / 266 片段 / 393 音符，以及"两条独立数据流
   对上同一个数"的定标证据（片段秒长 ↔ 源里 tick 累加）。
"""
from __future__ import annotations

import sys
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from dawview.rpp_parser import _Timebase, _split_tokens, parse_rpp  # noqa: E402

ROOT = Path(__file__).resolve().parent.parent
REAL_RPP = ROOT / "projects" / "dnb.rpp"


# ------------------------------------------------------------------ 合成工程

# 140 BPM 下 1 个四分音符 = 0.4285714285 秒；第 6 个四分音符处变速到 70 BPM。
# 于是 6.0 秒 = 正好 6 个四分音符 = 5760 tick（前面那 2.571428 秒是 140 BPM 段），
# 这一点是测试里跨变速点换算的锚。
SYNTH = """<REAPER_PROJECT 0.1 "7.67/win64" 1790084235 0
  SAMPLERATE 48000 1 0
  TEMPO 140 3 4 0
  <TEMPOENVEX
    EGUID {DFAFB394-1970-4594-A9F2-9E5134243B8E}
    DEFSHAPE 1 -1 -1
    PT 0 140 1
    PT 2.571428571428571 70 1
  >
  MARKER 1 6.0 "副歌" 0 0 1 R {0D349B7A-1A2B-4C3D-8E4F-95A6B7C8D9E0} 0
  MARKER 2 8.0 "区间" 1 0 1 R {1D349B7A-1A2B-4C3D-8E4F-95A6B7C8D9E1} 0
  MARKER 2 10.0 "" 1
  MARKER 3 12.0 "藏起来的" 16 0 1 R {2D349B7A-1A2B-4C3D-8E4F-95A6B7C8D9E2} 0
  <TRACK {AAAAAAAA-0000-0000-0000-000000000001}
    NAME Drums
    ISBUS 1 1
  >
  <TRACK {AAAAAAAA-0000-0000-0000-000000000002}
    NAME Kick
    ISBUS 0 0
    <ITEM
      POSITION 0
      LENGTH 1.5
      LOOP 1
      NAME "Kick 01"
      SOFFS 0
      PLAYRATE 1 1 0 -1 0 0.0025
      <SOURCE WAVE
        FILE "Media\\kick 01.wav"
      >
    >
  >
  <TRACK {AAAAAAAA-0000-0000-0000-000000000003}
    NAME Lead
    ISBUS 0 0
    <FXCHAIN
      SHOW 0
      <VST "VST3i: Serum (Xfer Records)" "Serum.vst3" 0 "" 1035478619{565354586}
        AAAA
      >
    >
    <FREEZE 0
      <ITEM
        POSITION 99
        LENGTH 99
        <SOURCE MIDI
          HASDATA 1 960 QN
          E 0 90 30 40
          E 960 80 30 00
        >
      >
    >
    <ITEM
      POSITION 6.0
      LENGTH 2.0
      LOOP 0
      NAME "Lead MIDI"
      SOFFS 0
      PLAYRATE 1 1 0 -1 0 0.0025
      <SOURCE MIDI
        HASDATA 1 960 QN
        CCINTERP 32
        E 0 90 3C 64
        E 480 80 3C 00
        E 0 90 3E 50
        E 480 90 3E 00
        e 0 b0 0B 50
        E 240 b0 0B 20
        E 0 90 40 7F
        E 480 b0 7B 00
      >
    >
  >
  <TRACK {AAAAAAAA-0000-0000-0000-000000000004}
    NAME ""
    ISBUS 2 -1
  >
  <TRACK {AAAAAAAA-0000-0000-0000-000000000005}
    NAME Rescale
    ISBUS 0 0
    <ITEM
      POSITION 0
      LENGTH 1.0
      NAME half
      <SOURCE MIDI
        HASDATA 1 480 QN
        E 0 90 45 7F
        E 240 80 45 00
      >
    >
    <ITEM
      POSITION 0
      LENGTH 0.5
      NAME "unknown source"
      <SOURCE CLICK
      >
    >
  >
>
"""


@pytest.fixture(scope="module")
def synth(tmp_path_factory):
    path = tmp_path_factory.mktemp("rpp") / "synth.rpp"
    path.write_text(SYNTH, encoding="utf-8")
    return parse_rpp(path).to_dict()


def test_header_and_project_settings(synth):
    meta = synth["meta"]
    assert meta["host"] == "reaper"
    assert meta["hostVersion"] == "7.67/win64"
    assert meta["projectName"] == "synth"          # 工程名不在文件里，用文件名
    assert meta["bpm"] == 140.0
    assert meta["timeSig"] == [3, 4]
    assert meta["ppq"] == 960
    assert meta["sampleRate"] == 48000.0
    assert synth["warnings"] == [
        "速度轨：2 个变速点（阶梯语义）",
        "认不出的片段源（SOURCE CLICK），按普通色块显示",
    ]


def test_tempo_map_is_steps_over_seconds(synth):
    # PT 的位置单位是秒 -> 第二个点（2.571428571428571 秒 = 6 个四分音符 @140）
    # 落在 5760 tick 上（前面那段按 140，后面那段按 70 递推）
    points = synth["tempoMap"]
    assert len(points) == 2
    assert points[0] == [0.0, 140.0]
    assert points[1][0] == pytest.approx(5760.0, abs=1e-3)
    assert points[1][1] == 70.0


def test_track_kinds_and_names(synth):
    kinds = [(t["name"], t["kind"]) for t in synth["tracks"]]
    assert kinds == [
        ("Drums", "folder"),        # ISBUS 1 1 = 文件夹父轨
        ("Kick", "audio"),
        ("Lead", "instrument"),     # FX 链里有 VST3i
        ("轨道 4", "other"),        # NAME "" + ISBUS 2 -1（文件夹收尾）也算普通轨
        ("Rescale", "midi"),
    ]


def test_audio_item_keeps_windows_path(synth):
    clip = synth["tracks"][1]["clips"][0]
    assert clip["kind"] == "audio"
    assert clip["name"] == "Kick 01"
    # 反斜杠是原样的：不能把 `\k` 当转义吃掉
    assert clip["audioFile"] == "Media\\kick 01.wav"
    # 140 BPM 下 1.5 秒 = 3.5 个四分音符 = 3360 tick
    assert clip["lengthTick"] == pytest.approx(3360.0)
    assert clip["notes"] == [] and clip["controllers"] == []


def test_midi_item_notes_cc_and_timebase(synth):
    clip = synth["tracks"][2]["clips"][0]
    assert clip["kind"] == "midi"
    assert clip["name"] == "Lead MIDI"
    # 6.0 秒：变速点在 2.5714 秒（= 6 个四分音符 @140）之后还有 3.42857 秒 @70
    # -> 5760 + 4 个四分音符 = 9600 tick
    assert clip["startTick"] == pytest.approx(9600.0, abs=1e-3)
    # 2.0 秒、全在 70 BPM 段里：2 × 70/60 × 960 = 2240 tick
    assert clip["lengthTick"] == pytest.approx(2240.0)

    notes = [(n["pitch"], n["startTick"], n["lengthTick"], n["velocity"]) for n in clip["notes"]]
    assert notes == [
        (60, 0.0, 480.0, 100),        # E 0 90 3C 64 -> 力度 0x64 = 100
        (62, 480.0, 480.0, 80),       # note-on 力度 0 当 note-off（0x50 = 80）
        (64, 1200.0, 480.0, 127),     # 没等到 off：收在源里最后一个事件（1680）上
    ]
    ccs = {c["cc"]: c for c in clip["controllers"]}
    assert ccs[11]["points"] == [[960.0, 80], [1200.0, 32]]
    assert ccs[11]["name"] == "表情"
    assert ccs[123]["points"] == [[1680.0, 0]]     # REAPER 收尾写的 CC123 照收
    assert ccs[123]["name"] == "全部音符关"


def test_lowercase_e_events_are_counted(synth):
    # 小写 e 那一行是 CC11 = 80 的第一个点：只收大写 E 的话这条曲线就只剩一个点
    clip = synth["tracks"][2]["clips"][0]
    cc11 = [c for c in clip["controllers"] if c["cc"] == 11][0]
    assert cc11["points"][0] == [960.0, 80]


def test_freeze_items_are_not_parsed(synth):
    # <FREEZE> 里的 <ITEM> 是"解冻时恢复用"的副本，画出来音符会翻倍
    # （那份副本 POSITION 99 秒、里面还有一条 C3 音符）
    clips = synth["tracks"][2]["clips"]
    assert [c["name"] for c in clips] == ["Lead MIDI"]
    assert [n["pitch"] for c in clips for n in c["notes"]] == [60, 62, 64]


def test_source_ppq_is_rescaled(synth):
    # HASDATA 1 480 QN：源 ppq 480 -> 契约 ppq 960，音符位置要 ×2
    clip = synth["tracks"][4]["clips"][0]
    assert clip["kind"] == "midi"
    assert [(n["startTick"], n["lengthTick"]) for n in clip["notes"]] == [(0.0, 480.0)]


def test_unknown_source_degrades_to_other_with_warning(tmp_path):
    path = tmp_path / "synth.rpp"
    path.write_text(SYNTH, encoding="utf-8")
    project = parse_rpp(path)
    other = project.tracks[4].clips[1]
    assert other.kind == "other" and other.notes == []
    assert any("认不出的片段源" in w for w in project.warnings)


def test_markers_skip_region_end_and_hidden(synth):
    # 区间只取起点那一行（8.0 秒 = 9600 + 2 秒 @70 = 11840 tick）；
    # 隐藏的（标志位 &16）不出现
    assert synth["markers"][0] == [pytest.approx(9600.0, abs=1e-3), "副歌"]
    assert synth["markers"][1] == [pytest.approx(11840.0, abs=1e-3), "区间"]
    assert len(synth["markers"]) == 2


def test_length_ticks_has_one_bar_tail(synth):
    # 最后一个片段结束在 9600 + 2240 = 11840，尾部加 4 拍（4 × 960）
    assert synth["lengthTicks"] == pytest.approx(11840.0 + 3840.0)


def test_rejects_non_rpp(tmp_path):
    bogus = tmp_path / "not.rpp"
    bogus.write_text("FLhd\x00\x00\x00\x06", encoding="latin-1")
    with pytest.raises(ValueError):
        parse_rpp(bogus)


# ------------------------------------------------------------------ 工具函数

def test_tokenizer_keeps_quotes_and_backslashes():
    assert _split_tokens('NAME "Drum Bus"') == ["NAME", "Drum Bus"]
    assert _split_tokens("NAME Snare") == ["NAME", "Snare"]
    assert _split_tokens('NAME ""') == ["NAME", ""]
    assert _split_tokens('FILE "Media\\kick 01.wav"') == ["FILE", "Media\\kick 01.wav"]
    assert _split_tokens('FILE "C:\\dir\\"') == ["FILE", "C:\\dir\\"]     # 结尾反斜杠
    assert _split_tokens('NAME "a\\"b"') == ["NAME", 'a"b']               # 转义引号


def test_timebase_roundtrip():
    tb = _Timebase([[0.0, 120.0], [4.0, 60.0]], 960)
    assert tb.sec_to_tick(4.0) == pytest.approx(7680.0)            # 4 s @120 = 8 拍
    assert tb.sec_to_tick(6.0) == pytest.approx(7680.0 + 1920.0)   # 再 2 s @60 = 2 拍
    assert tb.tick_to_sec(7680.0) == pytest.approx(4.0)
    assert tb.tick_to_sec(9600.0) == pytest.approx(6.0)
    for sec in (0.0, 1.0, 4.0, 5.5):
        assert tb.tick_to_sec(tb.sec_to_tick(sec)) == pytest.approx(sec, abs=1e-9)


def test_timebase_without_points_falls_back_to_120():
    tb = _Timebase([], 960)
    assert tb.sec_to_tick(2.0) == pytest.approx(3840.0)


# ------------------------------------------------------------- 真实工程（dnb.rpp）

@pytest.fixture(scope="module")
def real():
    if not REAL_RPP.exists():
        pytest.skip(f"没有真实工程 {REAL_RPP}（projects/ 不入库）")
    return parse_rpp(REAL_RPP).to_dict()


def test_real_project_header(real):
    meta = real["meta"]
    assert meta["host"] == "reaper"
    assert meta["hostVersion"] == "7.67/win64"
    assert meta["projectName"] == "dnb"
    assert meta["bpm"] == 190.0
    assert meta["timeSig"] == [4, 4]
    assert meta["ppq"] == 960
    assert meta["sampleRate"] == 44100.0
    # 定速工程：TEMPOENVEX 里没有 PT 点，退化成单点
    assert real["tempoMap"] == [[0.0, 190.0]]


def test_real_project_scale(real):
    clips = [c for t in real["tracks"] for c in t["clips"]]
    notes = [n for c in clips for n in c["notes"]]
    assert len(real["tracks"]) == 19
    assert len(clips) == 266
    assert len(notes) == 393
    kinds = {c["kind"] for c in clips}
    assert kinds == {"audio", "midi"}
    assert sum(1 for c in clips if c["kind"] == "audio") == 253
    assert sum(1 for c in clips if c["kind"] == "midi") == 13


def test_real_folder_tracks(real):
    folders = [(t["name"], t["kind"]) for t in real["tracks"] if t["kind"] == "folder"]
    assert folders == [("Drum Bus", "folder"), ("SFX", "folder"), ("Synth_Bus", "folder")]


def test_real_instrument_detection(real):
    by_name = {t["name"]: t["kind"] for t in real["tracks"]}
    assert by_name["Sub Bass"] == "instrument"      # FX 链里有 VST3i
    assert by_name["Arp"] == "instrument"
    assert by_name["Crash"] == "audio"              # ISBUS 2 -1 = 文件夹收尾，还是普通轨
    assert by_name["Side Chain"] == "midi"          # 纯 MIDI 轨，没有乐器


def test_real_seconds_to_ticks_ground_truth(real):
    """定标证据：片段秒长 × 速度 = 源里 tick 累加。

    "Side Chain" 那个片段 LENGTH 20.21052631578947 秒，190 BPM 下 = 64 个
    四分音符 = 61440 tick；它源里的 MIDI 事件偏移累加也正好是 61440。
    两个数来自文件里两处互不相干的地方，对上了才说明单位理解正确。
    """
    clip = next(c for t in real["tracks"] if t["name"] == "Side Chain" for c in t["clips"])
    assert clip["lengthTick"] == pytest.approx(61440.0)
    assert len(clip["notes"]) == 68
    last = max(n["startTick"] + n["lengthTick"] for n in clip["notes"])
    assert last == pytest.approx(61440.0)


def test_real_cc_and_physics(real):
    clips = [c for t in real["tracks"] for c in t["clips"]]
    midi = [c for c in clips if c["kind"] == "midi"]
    # 每个 MIDI 源末尾都有一条 CC123（REAPER 收尾写的）
    assert all(any(cc["cc"] == 123 for cc in c["controllers"]) for c in midi)
    # 音频片段只有路径、没有音符；路径保持宿主里的反斜杠写法
    audio = [c for c in clips if c["kind"] == "audio"]
    assert all(c["audioFile"] and c["notes"] == [] for c in audio)
    assert audio[0]["audioFile"].startswith("Media\\")
    # 音符不越片段边界、力度在范围内
    for c in clips:
        for n in c["notes"]:
            assert 0 <= n["startTick"]
            assert n["startTick"] + n["lengthTick"] <= c["lengthTick"] + 1e-6
            assert 0 <= n["pitch"] <= 127 and 1 <= n["velocity"] <= 127
