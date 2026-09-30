"""Studio One `.song` 解析器测试。

两段（跟 Cubase / FL / REAPER / Bitwig 那四份同构）：
1. 合成工程（总能跑）—— 按逆向出来的线格式手搓一份最小 `.song`：ZIP 里放
   `metainfo.xml` + `Song/song.xml` + `Song/mediapool.xml` + 两个 `.musicx`。
   重点覆盖那些"文档说不清、只能靠实测"的地方：
   **(a)** XML 里 `x:` 前缀没有 xmlns 声明（标准解析器会报 unbound prefix）；
   **(b)** 片段是**窗口**：音符坐标在源内容里，`offset` 是片段左缘，窗口外丢掉、
   跨界裁齐；**(c)** `quantize.start` / `quantize.velocity` 是"改动前是多少"的记录，
   **不要**加到值上（真实工程里 `velocity + quantize.velocity` 恒为宿主默认的 0.6）；
   **(d)** 位置单位跟轨道 `tempoFollow` 走（0 = 秒）、长度单位
   跟事件 `timeFormat` 走（0 = 秒）；**(e)** 分层轨的事件藏在 `List[id=Layers]` 里；
   **(f)** 音频部件（`AudioPartEvent`）的内部事件在媒体池的 `AudioPartClip` 里；
   **(g)** `.musicx` 容器的三种整数宽度（`i` / `U` / `I`）。
2. 真实工程（文件在才跑）—— projects/2025-08-29 39610.song 是 ground truth：
   162 BPM / 4-4 / 48 kHz / **62 条轨**（39 音频 + 17 乐器 + 1 MIDI + 5 总线）/
   **98 个 MIDI 片段 + 1942 个音频片段** / **11530 个音符**（另有 761 个落在片段
   内容窗口之外，Studio One 里不属于那些片段）。里面还有两条"独立数据流对上同一个数"
   的定标证据，都在下面断言里用上了。
"""
from __future__ import annotations

import collections
import struct
import sys
import zipfile
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from dawview.song_parser import _read_value, parse_song  # noqa: E402

ROOT = Path(__file__).resolve().parent.parent
REAL_SONG = ROOT / "projects" / "2025-08-29 39610.song"

XML_HEAD = '<?xml version="1.0" encoding="UTF-8"?>\r\n'


# ------------------------------------------------------------------ .musicx 写入

def c_member(name: str, payload: bytes) -> bytes:
    raw = name.encode("utf-8")
    return bytes([0x69, len(raw)]) + raw + payload


def c_int(value: int) -> bytes:
    """宿主按大小选整数宽度：`i` 1 字节 / `U` 1 字节 / `I` 2 字节。"""
    if 0 <= value < 0x80:
        return bytes([0x69, value])
    if 0 <= value < 0x100:
        return bytes([0x55, value])
    return bytes([0x49]) + struct.pack(">H", value)


def c_f64(value: float) -> bytes:
    return bytes([0x44]) + struct.pack(">d", value)


def c_obj(pairs: list[tuple[str, bytes]]) -> bytes:
    return b"{" + b"".join(c_member(k, v) for k, v in pairs) + b"}"


def c_arr(items: list[bytes]) -> bytes:
    return b"[" + b"".join(items) + b"]"


def note(start: float | None = None, pitch: int = 60, noteId: int = 1,
         length: float = 1.0, velocity: float = 0.6,
         qstart: float | None = None, qvel: float | None = None) -> bytes:
    """一个音符对象（键顺序照宿主：start → pitch → noteId → length → velocity）。"""
    pairs: list[tuple[str, bytes]] = []
    if start is not None:
        pairs.append(("start", c_f64(start)))
    pairs.append(("pitch", c_int(pitch)))
    pairs.append(("noteId", c_int(noteId)))
    pairs.append(("length", c_f64(length)))
    pairs.append(("velocity", c_f64(velocity)))
    if qstart is not None:
        pairs.append(("quantize.start", c_f64(qstart)))
    if qvel is not None:
        pairs.append(("quantize.velocity", c_f64(qvel)))
    return c_obj(pairs)


def musicx(events: list[bytes]) -> bytes:
    return c_obj([("timeFormat", c_int(2)), ("events", c_arr(events)),
                  ("envelopes", c_arr([]))])


# ------------------------------------------------------------------ song.xml 写入

def attr(ident: str, **kw) -> str:
    extra = "".join(f' {k.replace("_", ":")}="{v}"' for k, v in kw.items())
    return f'<Attributes x:id="{ident}"{extra}/>'


def build_song(path: Path) -> None:
    """手搓一份最小但覆盖各种坑的 .song。"""
    metainfo = XML_HEAD + (
        '<MetaInformation>\r\n'
        '\t<Attribute id="Document:Title" value="合成工程"/>\r\n'
        '\t<Attribute id="Document:Generator" value="Studio One/7.0.0.000001"/>\r\n'
        '\t<Attribute id="Media:SampleRate" value="44100"/>\r\n'
        '\t<Attribute id="Media:Tempo" value="120"/>\r\n'
        '</MetaInformation>\r\n')

    # 源内容：音符坐标是"源坐标"，片段 offset=1 表示片段左缘落在源的第 1 拍
    keys0 = musicx([
        note(start=1.0, pitch=60, noteId=1, length=0.5),                    # 窗口左缘
        note(pitch=62, noteId=2, length=1.0),                               # 缺 start = 0，窗口外
        note(start=2.01, pitch=63, noteId=3, length=0.5, qstart=-0.01),      # 量化记录不参与
        note(start=4.5, pitch=64, noteId=4, length=1.0, velocity=0.25,
             qvel=0.05),                                                     # 越右缘，裁齐
        note(start=5.5, pitch=65, noteId=0x200, length=1.0),                 # 完全在窗口外
    ])
    keys1 = musicx([note(start=0.0, pitch=48, noteId=1, length=2.0)])        # 第二层

    song = XML_HEAD + (
        '<Song popup="0">\r\n'
        '\t<Attributes x:id="Root" length="300">\r\n'
        '\t\t<Attributes x:id="timeContext" sampleRate="44100" frameType="1">\r\n'
        '\t\t\t<TempoMap x:id="tempoMap">\r\n'
        '\t\t\t\t<Attributes x:id="envelope">\r\n'
        '\t\t\t\t\t<EnvelopePoint value="0.5"/>\r\n'
        '\t\t\t\t</Attributes>\r\n'
        '\t\t\t\t<TempoMapSegment curveType="0" start="0" end="1e+200" tempo="0.5"/>\r\n'
        '\t\t\t\t<TempoMapSegment curveType="0" start="32" end="1e+200" tempo="0.25"/>\r\n'
        '\t\t\t</TempoMap>\r\n'
        '\t\t\t<TimeSignatureMap x:id="timeSignatureMap">\r\n'
        '\t\t\t\t<TimeSignatureMapSegment start="0" numerator="3" denominator="4"/>\r\n'
        '\t\t\t</TimeSignatureMap>\r\n'
        '\t\t</Attributes>\r\n'
        '\t\t<List x:id="Tracks">\r\n'
        '\t\t\t<MarkerTrack version="1" timeFormat="2">\r\n'
        f'\t\t\t\t{attr("attributes", hidden="1")}\r\n'
        '\t\t\t\t<MarkerEvent markerStop="0" markerType="2" timeFormat="2" name="开始"/>\r\n'
        '\t\t\t\t<MarkerEvent markerStop="0" markerType="2" start="8" timeFormat="2" name="副歌"/>\r\n'
        '\t\t\t</MarkerTrack>\r\n'
        '\t\t\t<ChordTrack version="1" timeFormat="2"><Attributes x:id="attributes" hidden="1"/></ChordTrack>\r\n'
        # 乐器轨：两个片段，一个正常、一个媒体池里没有
        '\t\t\t<MediaTrack mediaType="Music" tempoFollow="2" trackNumber="1" name="Keys" color="FF112233">\r\n'
        '\t\t\t\t<UID x:id="channelID" uid="{11111111-1111-1111-1111-111111111111}"/>\r\n'
        f'\t\t\t\t{attr("AutomationRegionList", visible="0")}\r\n'
        '\t\t\t\t<List x:id="Events">\r\n'
        '\t\t\t\t\t<MusicPart transpose="0" clipID="{P1}" start="4" timeFormat="2" '
        'length="4" offset="1" name="Verse">\r\n'
        '\t\t\t\t\t\t<Attributes x:id="attributes" trackID="{11111111-1111-1111-1111-111111111111}"/>\r\n'
        '\t\t\t\t\t</MusicPart>\r\n'
        '\t\t\t\t\t<MusicPart clipID="{NO_MEDIA}" start="16" timeFormat="2" length="2" name="空片段"/>\r\n'
        '\t\t\t\t\t<MusicPart clipID="{BROKEN}" start="20" timeFormat="2" length="2" name="坏文件"/>\r\n'
        '\t\t\t\t</List>\r\n'
        '\t\t\t</MediaTrack>\r\n'
        # 分层轨：自己没有 Events，事件在两个图层里
        '\t\t\t<MediaTrack mediaType="Music" tempoFollow="2" trackNumber="2" name="Layered" '
        'layerCount="2" activeLayer="1">\r\n'
        '\t\t\t\t<UID x:id="channelID" uid="{22222222-2222-2222-2222-222222222222}"/>\r\n'
        '\t\t\t\t<List x:id="Layers">\r\n'
        '\t\t\t\t\t<Attributes x:id="0" layerName="Layered 1">\r\n'
        '\t\t\t\t\t\t<List x:id="Events">\r\n'
        '\t\t\t\t\t\t\t<MusicPart clipID="{P3}" start="8" timeFormat="2" length="2" name="L1"/>\r\n'
        '\t\t\t\t\t\t</List>\r\n'
        '\t\t\t\t\t</Attributes>\r\n'
        '\t\t\t\t\t<Attributes x:id="1" layerName="Layered 2">\r\n'
        '\t\t\t\t\t\t<List x:id="Events">\r\n'
        '\t\t\t\t\t\t\t<MusicPart clipID="{P4}" start="12" timeFormat="2" length="2" name="L2"/>\r\n'
        '\t\t\t\t\t\t</List>\r\n'
        '\t\t\t\t\t</Attributes>\r\n'
        '\t\t\t\t</List>\r\n'
        '\t\t\t</MediaTrack>\r\n'
        # 音频轨（跟速度）：位置是拍
        '\t\t\t<MediaTrack mediaType="Audio" tempoFollow="2" trackNumber="3" name="Drums">\r\n'
        '\t\t\t\t<List x:id="Events">\r\n'
        '\t\t\t\t\t<AudioEvent clipID="{A1}" start="8" timeFormat="2" length="2" '
        'offset="0" name="kick" speed="1" transpose="0" tune="0"/>\r\n'
        '\t\t\t\t\t<AudioPartEvent clipID="{AP}" start="24" timeFormat="2" length="4" name="切片部件"/>\r\n'
        '\t\t\t\t</List>\r\n'
        '\t\t\t</MediaTrack>\r\n'
        # 音频轨（不跟速度）：位置是秒、长度是秒
        '\t\t\t<MediaTrack mediaType="Audio" tempoFollow="0" trackNumber="4" name="One Shot">\r\n'
        '\t\t\t\t<List x:id="Events">\r\n'
        '\t\t\t\t\t<AudioEvent clipID="{A1}" start="1.5" timeFormat="0" length="0.5" '
        'offset="0" name="snare" speed="1" transpose="0" tune="0"/>\r\n'
        '\t\t\t\t</List>\r\n'
        '\t\t\t</MediaTrack>\r\n'
        # 没有名字的轨
        '\t\t\t<MediaTrack mediaType="Audio" tempoFollow="2" trackNumber="5"/>\r\n'
        '\t\t\t<AutomationTrack version="1" trackID="{9}" timeFormat="2" name="总线 1"/>\r\n'
        '\t\t</List>\r\n'
        '\t</Attributes>\r\n'
        '</Song>\r\n')

    pool = XML_HEAD + (
        '<MediaPool>\r\n'
        '\t<Attributes x:id="rootFolder">\r\n'
        '\t\t<MediaFolder name="Music">\r\n'
        '\t\t\t<MusicClip mediaID="{P1}" useCount="1">\r\n'
        '\t\t\t\t<Url x:id="dataPath" type="1" url="media:///Performances/Keys/Keys(0).musicx"/>\r\n'
        '\t\t\t</MusicClip>\r\n'
        '\t\t\t<MusicClip mediaID="{P3}" useCount="1">\r\n'
        '\t\t\t\t<Url x:id="dataPath" type="1" url="media:///Performances/Keys/Keys(1).musicx"/>\r\n'
        '\t\t\t</MusicClip>\r\n'
        '\t\t\t<MusicClip mediaID="{P4}" useCount="1">\r\n'
        '\t\t\t\t<Url x:id="dataPath" type="1" url="media:///Performances/Keys/Keys(2).musicx"/>\r\n'
        '\t\t\t</MusicClip>\r\n'
        '\t\t\t<MusicClip mediaID="{BROKEN}" useCount="1">\r\n'
        '\t\t\t\t<Url x:id="dataPath" type="1" url="media:///Performances/Keys/Keys(3).musicx"/>\r\n'
        '\t\t\t</MusicClip>\r\n'
        '\t\t</MediaFolder>\r\n'
        '\t\t<MediaFolder name="Audio">\r\n'
        '\t\t\t<AudioClip mediaID="{A1}" useCount="3">\r\n'
        '\t\t\t\t<Url x:id="path" type="1" url="file:///D:/samples/drums/kick.wav"/>\r\n'
        '\t\t\t\t<Attributes x:id="format" frameCount="44100" sampleRate="44100"/>\r\n'
        '\t\t\t</AudioClip>\r\n'
        '\t\t</MediaFolder>\r\n'
        '\t\t<MediaFolder name="AudioParts">\r\n'
        '\t\t\t<AudioPartClip mediaID="{AP}" name="切片部件" useCount="1" eventFormat="2">\r\n'
        '\t\t\t\t<Attributes x:id="Events" timeFormat="2" length="4">\r\n'
        '\t\t\t\t\t<AudioEvent clipID="{A1}" start="1" timeFormat="2" length="0.5" '
        'offset="0" name="kick" speed="1" transpose="0" tune="0"/>\r\n'
        '\t\t\t\t\t<AudioEvent clipID="{A1}" start="3" timeFormat="2" length="1" '
        'offset="0" name="kick" speed="1" transpose="0" tune="0"/>\r\n'
        '\t\t\t\t</Attributes>\r\n'
        '\t\t\t</AudioPartClip>\r\n'
        '\t\t</MediaFolder>\r\n'
        '\t</Attributes>\r\n'
        '</MediaPool>\r\n')

    device = XML_HEAD + (
        '<MusicTrackDevice>\r\n'
        '\t<ChannelGroup name="MusicTrack">\r\n'
        '\t\t<MusicTrackChannel name="Channel01" label="Keys">\r\n'
        '\t\t\t<UID x:id="uniqueID" uid="{11111111-1111-1111-1111-111111111111}"/>\r\n'
        '\t\t\t<Connection x:id="instrumentOut" objectID="{X}/Input" friendlyName="Keys"/>\r\n'
        '\t\t</MusicTrackChannel>\r\n'
        '\t\t<MusicTrackChannel name="Channel02" label="Layered">\r\n'
        '\t\t\t<UID x:id="uniqueID" uid="{22222222-2222-2222-2222-222222222222}"/>\r\n'
        '\t\t</MusicTrackChannel>\r\n'
        '\t</ChannelGroup>\r\n'
        '</MusicTrackDevice>\r\n')

    with zipfile.ZipFile(path, "w") as zf:
        zf.writestr("metainfo.xml", metainfo)
        zf.writestr("Song/song.xml", song)
        zf.writestr("Song/mediapool.xml", pool)
        zf.writestr("Devices/musictrackdevice.xml", device)
        zf.writestr("Performances/Keys/Keys(0).musicx", keys0)
        zf.writestr("Performances/Keys/Keys(1).musicx", keys1)
        zf.writestr("Performances/Keys/Keys(2).musicx", keys1)
        zf.writestr("Performances/Keys/Keys(3).musicx", b"\x7b\x69\x09garbage")


@pytest.fixture(scope="module")
def synth(tmp_path_factory) -> dict:
    path = tmp_path_factory.mktemp("song") / "合成工程.song"
    build_song(path)
    return parse_song(path).to_dict()


# ------------------------------------------------------------------ 合成工程断言

def test_meta(synth):
    assert synth["meta"] == {
        "host": "studioone",
        "hostVersion": "7.0.0.000001",
        "projectName": "合成工程",
        "bpm": 120.0,
        "timeSig": [3, 4],
        "ppq": 480,
        "sampleRate": 44100.0,
    }


def test_tempo_and_markers(synth):
    # 两段速度：0 拍 120 BPM，32 拍起 240 BPM（tempo=0.25 秒/拍）→ 阶梯
    assert synth["tempoMap"] == [[0.0, 120.0], [32 * 480, 240.0]]
    assert any("阶梯" in w for w in synth["warnings"])
    # MarkerEvent 没有 start = 第 0 拍
    assert synth["markers"] == [[0.0, "开始"], [8 * 480, "副歌"]]


def test_tracks_and_kinds(synth):
    kinds = [(t["name"], t["kind"]) for t in synth["tracks"]]
    assert kinds == [
        ("Keys", "instrument"),        # 通道里有 instrumentOut 连接
        ("Layered", "midi"),           # 没有乐器连接
        ("Drums", "audio"),
        ("One Shot", "audio"),
        ("轨道 5", "audio"),           # 没有名字的轨
        ("总线 1", "bus"),
    ]
    # 和弦轨被跳过
    assert any("非内容轨" in w for w in synth["warnings"])


def test_midi_clip_window(synth):
    """片段是窗口：源坐标 - offset，窗口外丢掉、跨界裁齐。"""
    keys = synth["tracks"][0]
    verse = keys["clips"][0]
    assert (verse["name"], verse["kind"]) == ("Verse", "midi")
    assert verse["startTick"] == 4 * 480
    assert verse["lengthTick"] == 4 * 480
    notes = verse["notes"]
    # 源内容 1.0 / 2.01 / 4.5(裁到 5.0) 三条留下，源 0 与 5.5 两条在窗口外
    assert [n["pitch"] for n in notes] == [60, 63, 64]
    # `quantize.start` / `quantize.velocity` 是"改动前是多少"的记录，不加到值上：
    # 2.01 就画在 2.01（不是 2.00），力度 0.25 就是 0.25（不是 0.30）
    assert [round(n["startTick"], 6) for n in notes] == [0.0, 484.8, 1680.0]
    assert [round(n["lengthTick"], 6) for n in notes] == [240.0, 240.0, 240.0]
    assert [n["velocity"] for n in notes] == [76, 76, 32]
    # 音符不许露出片段
    for n in notes:
        assert n["startTick"] >= 0 and n["startTick"] + n["lengthTick"] <= verse["lengthTick"]
    assert any("内容窗口之外" in w for w in synth["warnings"])


def test_media_problems(synth):
    keys = synth["tracks"][0]
    assert [c["name"] for c in keys["clips"]] == ["Verse", "空片段", "坏文件"]
    assert keys["clips"][1]["notes"] == []          # 媒体池里没有 → 只画色块
    assert keys["clips"][2]["notes"] == []          # 文件读不动
    assert any("找不到" in w for w in synth["warnings"])
    assert any("读不动" in w for w in synth["warnings"])


def test_layers(synth):
    """分层轨：事件藏在 List[id=Layers] 里，两层都要收。"""
    layered = synth["tracks"][1]
    assert [(c["name"], c["startTick"], len(c["notes"])) for c in layered["clips"]] == [
        ("L1", 8 * 480, 1), ("L2", 12 * 480, 1)]
    assert layered["clips"][0]["notes"][0]["pitch"] == 48


def test_audio_units(synth):
    """位置跟 tempoFollow 走（0 = 秒），长度跟 timeFormat 走（0 = 秒）。"""
    drums = synth["tracks"][2]
    kick = drums["clips"][0]
    assert kick["kind"] == "audio" and kick["name"] == "kick"
    assert kick["startTick"] == 8 * 480                      # 拍
    assert kick["lengthTick"] == 2 * 480
    assert kick["audioFile"] == "D:/samples/drums/kick.wav"
    one_shot = synth["tracks"][3]["clips"][0]
    # 1.5 秒 @120 BPM = 3 拍 = 1440 tick；0.5 秒 = 1 拍 = 480 tick
    assert one_shot["startTick"] == 1440.0
    assert one_shot["lengthTick"] == 480.0


def test_audio_part(synth):
    """音频部件：内部事件在媒体池里，位置相对部件起点。"""
    drums = synth["tracks"][2]
    inner = drums["clips"][1:]
    assert [(c["startTick"], c["lengthTick"]) for c in inner] == [
        (24 * 480 + 1 * 480, 0.5 * 480), (24 * 480 + 3 * 480, 1 * 480)]
    assert all(c["audioFile"].endswith("kick.wav") for c in inner)


def test_length_ticks(synth):
    # 最晚内容 = 部件内部事件结束（27+1=28 拍），再留一小节
    assert synth["lengthTicks"] == 28 * 480 + 4 * 480


def test_container_widths():
    """`.musicx` 的三种整数宽度都能读，坏标签要报错。"""
    data = c_obj([("a", c_int(7)), ("b", c_int(200)), ("c", c_int(4000)),
                  ("d", c_f64(0.25)), ("e", c_arr([c_int(1), c_int(2)]))])
    value, used = _read_value(data, 0)
    assert value == {"a": 7, "b": 200, "c": 4000, "d": 0.25, "e": [1, 2]}
    assert used == len(data)
    with pytest.raises(ValueError):
        _read_value(b"\x7b\x69\x01", 0)


# ------------------------------------------------------------------ 真实工程

needs_real = pytest.mark.skipif(not REAL_SONG.exists(),
                                reason="projects/2025-08-29 39610.song 不在（真实工程段跳过）")


@pytest.fixture(scope="module")
def real() -> dict:
    return parse_song(REAL_SONG).to_dict()


@needs_real
def test_real_meta(real):
    assert real["meta"]["host"] == "studioone"
    assert real["meta"]["hostVersion"] == "7.1.0.104182"
    assert real["meta"]["projectName"] == "2025-08-29 39610"
    assert real["meta"]["bpm"] == 162.0
    assert real["meta"]["timeSig"] == [4, 4]
    assert real["meta"]["ppq"] == 480
    assert real["meta"]["sampleRate"] == 48000.0
    # 速度另有一条独立数据流：metainfo 里的 Media:Tempo 也是 162
    assert real["tempoMap"] == [[0.0, 162.0]]


@needs_real
def test_real_markers(real):
    # "结束" 在第 600 拍：600 × 60 / 162 = 222.222 秒，与 metainfo 的 Media:Length 一致
    assert real["markers"] == [[0.0, "开始"], [288000.0, "结束"]]
    assert abs(288000 / 480 * 60 / 162 - 222.2222222222222) < 1e-9


@needs_real
def test_real_tracks_and_clips(real):
    kinds = {}
    for t in real["tracks"]:
        kinds[t["kind"]] = kinds.get(t["kind"], 0) + 1
    assert kinds == {"audio": 39, "instrument": 17, "midi": 1, "bus": 5}
    clips = [c for t in real["tracks"] for c in t["clips"]]
    assert len([c for c in clips if c["kind"] == "midi"]) == 98      # 98 个 MusicPart
    assert len([c for c in clips if c["kind"] == "audio"]) == 1942   # 1930 + 部件内 12 个
    assert all(c["audioFile"] for c in clips if c["kind"] == "audio")
    # MIDI 片段全都解出了音符（没有"只画色块"的）
    assert all(len(c["notes"]) > 0 for c in clips if c["kind"] == "midi")


@needs_real
def test_real_notes(real):
    notes = [n for t in real["tracks"] for c in t["clips"] for n in c["notes"]]
    assert len(notes) == 11530
    assert any("761 个音符" in w for w in real["warnings"])
    assert min(n["pitch"] for n in notes) == 38
    assert max(n["pitch"] for n in notes) == 91
    assert min(n["velocity"] for n in notes) >= 1
    assert max(n["velocity"] for n in notes) <= 127


@needs_real
def test_real_velocities(real):
    """力度取文件里存的值，**不**加 `quantize.velocity`。

    实测真值：全工程 44 档力度（76 = 宿主默认 0.6 占绝大多数，另有 95 / 75 / 67 …）。
    加偏移那种读法会把所有音符塌成 76 / 102 两档 —— 用户对着 Studio One 一眼看出来的
    就是这个。M1 那条轨是判据本身：160 个音符力度各不相同，而
    `velocity + quantize.velocity` 恒等于 0.6（= 当初画在默认力度上，后来被改过）。
    """
    notes = [n for t in real["tracks"] for c in t["clips"] for n in c["notes"]]
    dist = collections.Counter(n["velocity"] for n in notes)
    assert len(dist) == 44, dist.most_common(5)
    assert dist[76] == 11132                      # 宿主默认力度 0.6 → 76
    assert dist[95] == 124                        # 0.75 那一轨（Ample Bass J）原样保留
    m1 = next(t for t in real["tracks"] if t["name"] == "M1")
    first = m1["clips"][0]["notes"]
    assert len({n["velocity"] for n in first}) == 43
    assert min(n["velocity"] for n in first) == 39
    assert max(n["velocity"] for n in first) == 84


@needs_real
def test_real_note_invariants(real):
    for t in real["tracks"]:
        for c in t["clips"]:
            assert c["lengthTick"] > 0
            assert c["startTick"] >= 0
            for n in c["notes"]:
                assert n["startTick"] >= -1e-6
                assert n["lengthTick"] > 0
                assert n["startTick"] + n["lengthTick"] <= c["lengthTick"] + 1e-6


@needs_real
def test_real_length(real):
    """最晚内容是第 640 拍 = 237.037 秒 —— 与走带文件里的 loopEnd 一致。"""
    end = max(c["startTick"] + c["lengthTick"] for t in real["tracks"] for c in t["clips"])
    assert end == 640 * 480
    assert abs(640 * 60 / 162 - 237.03703703703704) < 1e-9
    assert real["lengthTicks"] == end + 4 * 480


@needs_real
def test_real_position_units(real):
    """位置单位判据：同一条轨复制出来的两份，位置应当逐条相同。

    VOLTA 那份 `timeFormat=2`（长度按拍 = 0.5 拍），91V 那份 `timeFormat=0`
    （长度按秒 = 0.3214 秒 = 采样文件时长）——两份的**位置**却都是拍。
    """
    def track_of(prefix: str) -> dict:
        return next(t for t in real["tracks"] if t["name"].startswith(prefix))

    volta, snare = track_of("VOLTA_SNARE"), track_of("91V_HG_snare")
    assert len(volta["clips"]) == len(snare["clips"]) == 155
    assert [c["startTick"] for c in volta["clips"]] == [c["startTick"] for c in snare["clips"]]
    assert volta["clips"][0]["startTick"] == 65 * 480
    assert volta["clips"][0]["lengthTick"] == 240            # 0.5 拍
    # 秒单位长度：0.321383 秒 × 162/60 × 480 = 416.5 tick（≈ 采样文件时长）
    assert snare["clips"][0]["lengthTick"] == pytest.approx(416.512653, abs=0.01)


@needs_real
def test_real_seconds_positions(real):
    """不跟速度的轨（tempoFollow=0）位置存秒：起始都落在"整拍秒"网格上。"""
    kick = next(t for t in real["tracks"] if t["name"].startswith("KSHMR Acoustic Kick"))
    assert len(kick["clips"]) == 24
    for c in kick["clips"]:
        beats = c["startTick"] / 480
        assert abs(beats - round(beats)) < 1e-6, c
    assert kick["clips"][-1]["startTick"] == 317 * 480       # 117.4074 秒 = 317 拍


@needs_real
def test_real_instruments(real):
    """乐器判定看通道里有没有 instrumentOut：18 条 Music 轨里 1 条是纯 MIDI 轨。"""
    music = [t for t in real["tracks"] if t["kind"] in ("instrument", "midi")]
    assert len(music) == 18
    assert [t["name"] for t in music if t["kind"] == "midi"] == ["Track"]
    pianoteq = next(t for t in real["tracks"] if t["name"] == "Pianoteq 6 (64-bit)")
    assert [(c["startTick"] // 480, c["lengthTick"] // 480, len(c["notes"]))
            for c in pianoteq["clips"]] == [(0, 60, 224), (64, 60, 224), (128, 60, 224),
                                            (576, 60, 224)]
