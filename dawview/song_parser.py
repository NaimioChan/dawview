"""Studio One `.song` parser（实证逆向，实测 Studio One 7.1.0.104182）。

实测工程："2025-08-29 39610.song"（162 BPM / 4-4 / 48 kHz / 57 条内容轨 + 5 条总线 /
演奏文件里 12291 个音符，其中 11530 个落在片段窗口内）。
契约见 docs/01-data-contract.md。

======================= 容器 =======================
`.song` 就是一份 **ZIP**（头 4 字节 `PK\\x03\\x04`），里面是 XML + 二进制"演奏"文件：

    metainfo.xml               标题 / 作者 / 生成器版本 / 速度 / 拍号 / 采样率 / 轨道数
    Song/song.xml              走带：速度图、拍号图、标记、轨道与事件
    Song/mediapool.xml         媒体池：mediaID ↔ 文件路径（音频 / MIDI 演奏）
    Devices/*.xml              设备与通道（乐器通道、混音台、走带）
    Performances/<乐器>/<名>(n).musicx   MIDI 音符（每个片段一份）
    Envelopes/<通道>/*.envelopex         自动化包络（本期不渲染）
    Presets/**                 插件预设（不读）

**XML 属性前缀没有声明**：Studio One 写的是 `x:id="Events"`，但整份文档里没有
`xmlns:x=...` —— 标准 XML 解析器会直接报 `unbound prefix`。这里先补一个 xmlns 再解开
（`_load_xml`），属性值原样不动。

======================= 时间单位（最坑的地方）=======================
同一份 `.song` 里位置/长度有**两套单位**，而且分别由两个不同的地方决定：

- **`timeFormat` 决定"长度"的单位**：`2` = 拍（四分音符），`0` = **秒**。
  判据：`timeFormat=0` 的 1053 个音频事件，长度 ÷ 音频文件时长（媒体池里的
  `frameCount / sampleRate`）中位 0.99、上界 1.000 —— 整段采样拖进来时长度正好等于
  文件时长；按"拍"读的话这些值会整体差一个 162/60 = 2.7 倍（上界只剩 0.37），对不上。
- **轨道的 `tempoFollow` 决定"位置"的单位**：`0` = 不跟速度 → 位置是**秒**；
  `2` = 跟速度 → 位置是**拍**。两条独立判据：
  ① 同一条轨复制出来的两份（VOLTA / 91V 军鼓，各 155 个事件）位置数字逐条相同
  （65, 67, …, 635），其中 tf=2 那份只能是拍（间距 2 拍 = 军鼓落 2、4 拍），另一份
  tf=0 也是同一批数字 → **位置单位不跟 tf 走**；
  ② 按轨道统计"位置落在整拍秒网格 / 1/4 拍网格"的比例：tempoFollow=0 的 15 条轨
  **100%** 落在"秒 × 2.7 = 整数"的网格上、且位置都在 237 秒（工程长度）以内；
  tempoFollow=2 的轨 100% 落在 1/4 拍网格上、最大 638.75 拍（= 工程末尾）。两组各
  100%，中间没有含混的。
- MIDI 演奏文件（.musicx）里的音符位置/时长**一律是拍**（f64）。
- 拍 → tick 直接 × ppq；秒 → tick 走速度图分段积分（`_Tempo`）。

======================= 事件容器 =======================
`<List x:id="Tracks">` 下按显示顺序排：`MarkerTrack` / `ChordTrack` / `ArrangerTrack` /
`LyricsTrack` / `VideoTrack` / 57 个 `MediaTrack` / 5 个 `AutomationTrack`。本解析器：
MediaTrack → 轨道；MarkerTrack → 标记；AutomationTrack → `kind: "bus"` 的空行
（它的内容是 .envelopex 自动化，本期不画）；Chord/Arranger/Lyrics/Video 跳过。

`MediaTrack` 的事件在 `<List x:id="Events">` 下：`MusicPart`（MIDI 片段）、
`AudioEvent`（音频片段）、`AudioPartEvent`（音频"部件"——它自己不带音频事件，
要拿 `clipID` 去媒体池的 `AudioPartClip` 里翻内部事件）。
**分层轨**：带 `layerCount` 的轨**自己没有 Events**，事件在
`<List x:id="Layers">` → 每层 `<Attributes id="N">` → `<List x:id="Events">` 里；
所有层都收（Studio One 的 layer 是替代 take / comp，契约里没有分层概念）。

轨道种类：`mediaType` = Music / Audio；Music 轨再按
`Devices/musictrackdevice.xml` 里同名通道有没有 `instrumentOut` 连接分
instrument / midi（实测 18 条 Music 轨里有 1 条没有乐器，是一条纯 MIDI 轨）。

======================= 媒体池 =======================
`Song/mediapool.xml` 里 `MusicClip` / `AudioClip` / `AudioPartClip` 各带 `mediaID`，
与事件上的 `clipID` 对应（实测 98 个 MusicPart ↔ 98 个 MusicClip 全部对上）：
- `MusicClip` → `media:///Performances/<乐器>/<名>(n).musicx`
- `AudioClip` → `file:///D:/…/sample.wav`（**音频不进 .song**，工程旁边才有文件）
- `AudioPartClip` → 没有 Url，内部 `Attributes[id=Events]` 里裹着真正的 `AudioEvent`
  （位置相对部件起点，单位拍）

======================= MIDI 演奏文件 .musicx =======================
自定义容器（与 .song 里别的数据同族）：

    '{' 对象开始 / '}' 结束；'[' 数组开始 / ']' 结束
    成员 = 0x69 单字节 + [u8 名字长度][名字 utf8] + 值
    值的类型标签：0x69 'i' / 0x55 'U' = 1 字节，0x49 'I' = 2 字节，
                  0x44 'D' = f64(BE)，0x46 'F' = f32(BE)

顶层是 `{timeFormat, events[...], envelopes[]}`，每个音符
`{start?, pitch, noteId, length, velocity, quantize.*?}`：
- **`start` 缺失 = 0**（实测 97 个音符没有这个键）
- `pitch` 0-127；`length` 拍；`velocity` 是 **0..1 的浮点**（× 127 取整进契约）
- **`quantize.start` / `quantize.velocity` 是"改动前是多少"的记录，不要加到值上**：
  文件里的 `start` / `velocity` 就是宿主当前显示/播放的值。判据（两条，第二条是决定性的）：
  ① 位置：130 个带 `quantize.start` 的音符里，`start` 落在 1/4 拍网格上的有 0 个，
  而 `start + quantize.start` 有 122 个 —— 说明那批音符**曾经**在网格上、后来被挪开了，
  偏移记的是挪开前后的差；
  ② 力度：M1 那条轨的 160 个音符 `velocity` 各不相同（0.308…0.658，117 个取值），
  但 `velocity + quantize.velocity` **恒等于 0.6** —— 就是"当初画在宿主默认力度 0.6，
  后来被改成现在这个值"。按"加上偏移"读，整份工程的力度会塌成 76 / 102 两档，
  真值是 44 档（用户对着 Studio One 一眼就看出来了）。
- `noteId` 是宿主内部编号（1 字节 / 2 字节两种写法都见过），不出口
- `envelopes` 实测 98 个文件全是空数组 → 契约的 `controllers` 恒为 `[]`（跟 FL 一样）

======================= 片段是"窗口" =======================
`MusicPart` 的 `offset` = **片段左缘对应源内容里的位置**（拍），音符坐标在源内容里：

    音符显示位置 = 片段起点 + (音符位置 − offset)

窗口 `[offset, offset+length]` 之外的音符在 Studio One 里不属于这个片段（不显示、
不播放），解析时丢掉；跨窗口边界的音符按窗口裁齐（契约里"音符不出片段"是硬约定）。
实测 12291 个音符里丢掉 761 个。判据：`源内容最大位置 − offset == 片段长度`
在 offset = 0 / 32 / −4 三种情况下都严格成立（98 个片段里 16 个 offset 非零）——
和 FL 的"模式片段修剪"、Bitwig 的"内容窗口"是同一类坑。

======================= 已知取舍 =======================
- **自动化不画**：`AutomationTrack` / `MediaTrack` 的 `AutomationRegion` 指向
  `Envelopes/*.envelopex`（同一个容器格式，位置单位同样是拍），契约里 `AutomationTrack`
  还是预留字段，本期只把总线轨画成空行。
- **静音的片段**（`MusicPart` 的 `mute=1`，实测 18 个）照常画 —— 契约里没有静音字段。
- **循环播放的音频事件**（`loopEnabled`，实测 36 个）不展开循环。
- `transpose` / `speed` / `tune`（移调、变速：实测 40 个 speed=0.375、13 个 transpose=2）
  不参与时间轴换算 —— 契约里的音频片段就是"区间色块"。
- 不解析 `Song/editor.xml`、`Song/score.notion`、混音台与插件预设。
"""
from __future__ import annotations

import struct
import zipfile
from pathlib import Path
from xml.etree import ElementTree as ET

from .model import Clip, Note, Project, Track, normalize_tempo_map

PROJECT_PPQ = 480             # 契约 tick 密度（实测工程里 1/32 音符 = 60 tick，除得尽）
DEFAULT_SAMPLE_RATE = 48000.0
BPM_MIN, BPM_MAX = 5.0, 999.0
TAIL_BEATS = 4                # lengthTicks 在最后一段内容后留一小节

TF_SECONDS = "0"              # timeFormat 0 = 秒（绝对时间）
TF_BEATS = "2"                # timeFormat 2 = 拍（四分音符）
FOLLOW_OFF = "0"              # tempoFollow 0 = 不跟速度 → 位置存秒

EPS = 1e-6                    # 浮点噪声容差（单位：拍）

# .musicx / .envelopex 容器
CHUNK_MEMBER = 0x69
OBJ_OPEN, OBJ_CLOSE = 0x7B, 0x7D
ARR_OPEN, ARR_CLOSE = 0x5B, 0x5D
INT_WIDTH = {0x69: 1, 0x55: 1, 0x49: 2}      # 'i' / 'U' / 'I'
TAG_F64, TAG_F32 = 0x44, 0x46


# ------------------------------------------------------------------ 容器读取

class _ChunkError(ValueError):
    """`.musicx` / `.envelopex` 容器读崩了。"""


def _read_value(data: bytes, pos: int):
    """读一个容器值，返回 (值, 新位置)。"""
    if pos >= len(data):
        raise _ChunkError("读到文件末尾")
    tag = data[pos]
    if tag == OBJ_OPEN:
        out: dict = {}
        pos += 1
        while True:
            if pos >= len(data):
                raise _ChunkError("对象没关上")
            head = data[pos]
            if head == OBJ_CLOSE:
                return out, pos + 1
            if head != CHUNK_MEMBER:
                raise _ChunkError(f"对象成员前期待 0x69，得到 0x{head:02x}（偏移 {pos}）")
            pos += 1
            if pos >= len(data):
                raise _ChunkError("成员名长度缺失")
            n = data[pos]
            pos += 1
            name = data[pos:pos + n].decode("utf-8", "replace")
            pos += n
            val, pos = _read_value(data, pos)
            out[name] = val
    if tag == ARR_OPEN:
        items: list = []
        pos += 1
        while True:
            if pos >= len(data):
                raise _ChunkError("数组没关上")
            if data[pos] == ARR_CLOSE:
                return items, pos + 1
            val, pos = _read_value(data, pos)
            items.append(val)
    if tag in INT_WIDTH:
        width = INT_WIDTH[tag]
        raw = data[pos + 1:pos + 1 + width]
        if len(raw) < width:
            raise _ChunkError("整数被截断")
        return int.from_bytes(raw, "big"), pos + 1 + width
    if tag == TAG_F64:
        return struct.unpack_from(">d", data, pos + 1)[0], pos + 9
    if tag == TAG_F32:
        return struct.unpack_from(">f", data, pos + 1)[0], pos + 5
    raise _ChunkError(f"未知类型标签 0x{tag:02x}（偏移 {pos}）")


def _music_events(data: bytes) -> list[dict]:
    """`.musicx` 字节 -> 音符字典列表。"""
    value, _ = _read_value(data, 0)
    if not isinstance(value, dict):
        raise _ChunkError("顶层不是对象")
    events = value.get("events")
    if not isinstance(events, list):
        return []
    return [e for e in events if isinstance(e, dict)]


# ------------------------------------------------------------------ XML 小工具

def _load_xml(raw: bytes) -> ET.Element:
    """解 Studio One 的 XML。

    它写的属性前缀 `x:` 没有对应的 `xmlns` 声明（标准解析器报 unbound prefix），
    所以先包一层补上声明；已经声明过的文件原样解。
    """
    text = raw.decode("utf-8-sig")
    if text.startswith("<?xml"):
        text = text.split("?>", 1)[1]
    if "xmlns:x" not in text:
        text = '<dawview xmlns:x="urn:dawview:prefixed">' + text + "</dawview>"
    return ET.fromstring(text)


def _tag(el: ET.Element) -> str:
    return el.tag.split("}")[-1]


def _prop(el: ET.Element, name: str, default: str | None = None) -> str | None:
    """读属性；`x:id` 这种带前缀的按去掉前缀的名字读。"""
    if name in el.attrib:
        return el.attrib[name]
    for key, value in el.attrib.items():
        if key.split("}")[-1] == name:
            return value
    return default


def _num(value: str | None, default: float = 0.0) -> float:
    try:
        return float(value)          # type: ignore[arg-type]
    except (TypeError, ValueError):
        return default


def _children(el: ET.Element, tag: str) -> list[ET.Element]:
    return [c for c in el if _tag(c) == tag]


def _list_with_id(el: ET.Element, want: str) -> ET.Element | None:
    for c in el:
        if _tag(c) == "List" and _prop(c, "id") == want:
            return c
    return None


def _attrs_with_id(el: ET.Element, want: str) -> ET.Element | None:
    for c in el:
        if _tag(c) == "Attributes" and _prop(c, "id") == want:
            return c
    return None


def _find_by_id(root: ET.Element, want: str) -> ET.Element | None:
    """整棵树里按 `x:id` 找第一个元素（轨道列表埋在 `<Attributes id="Root">` 里）。"""
    for el in root.iter():
        if _prop(el, "id") == want:
            return el
    return None


def _file_from_url(url: str) -> str:
    """`file:///D:/…/x.wav` / `media:///Performances/…` -> 原样路径。"""
    for prefix in ("file:///", "file://", "media:///", "media://"):
        if url.startswith(prefix):
            return url[len(prefix):]
    return url


# ------------------------------------------------------------------ 速度 / 时间轴

class _Tempo:
    """速度图：拍 ↔ 秒 的换算（阶梯语义：一个点保持到下一个点）。

    `segments` 是 [(起始拍, bpm), ...]，升序、首点在第 0 拍。
    """

    def __init__(self, segments: list[tuple[float, float]], ppq: float):
        self.ppq = float(ppq)
        self.segs = segments or [(0.0, 120.0)]
        self.sec_at: list[float] = []
        acc = 0.0
        for i, (beat, bpm) in enumerate(self.segs):
            self.sec_at.append(acc)
            if i + 1 < len(self.segs):
                acc += (self.segs[i + 1][0] - beat) * 60.0 / bpm

    def beat_to_tick(self, beat: float) -> float:
        return beat * self.ppq

    def sec_to_tick(self, sec: float) -> float:
        i = 0
        while i + 1 < len(self.segs) and self.sec_at[i + 1] <= sec:
            i += 1
        beat, bpm = self.segs[i]
        return self.beat_to_tick(beat) + (sec - self.sec_at[i]) * bpm / 60.0 * self.ppq

    def tick_to_sec(self, tick: float) -> float:
        tick = max(0.0, tick)
        i = 0
        while i + 1 < len(self.segs) and self.beat_to_tick(self.segs[i + 1][0]) <= tick:
            i += 1
        beat, bpm = self.segs[i]
        return self.sec_at[i] + (tick - self.beat_to_tick(beat)) / (self.ppq * bpm / 60.0)

    def points(self) -> list[list[float]]:
        return [[self.beat_to_tick(beat), bpm] for beat, bpm in self.segs]

    def pos_to_tick(self, value: float, follow: str | None) -> float:
        """事件位置：不跟速度的轨存秒，跟速度的轨存拍。"""
        if follow == FOLLOW_OFF:
            return self.sec_to_tick(value)
        return self.beat_to_tick(value)

    def length_to_tick(self, value: float, time_format: str | None,
                       start_tick: float) -> float:
        """事件长度：`timeFormat` 0 = 秒、2 = 拍（见文件头说明）。"""
        if time_format == TF_SECONDS:
            sec0 = self.tick_to_sec(start_tick)
            return self.sec_to_tick(sec0 + value) - start_tick
        return value * self.ppq


# ------------------------------------------------------------------ 媒体池

class _Media:
    """媒体池条目：`MusicClip` / `AudioClip` / `AudioPartClip`。"""

    __slots__ = ("kind", "url", "file", "inner")

    def __init__(self, kind: str, url: str, inner: list[ET.Element]):
        self.kind = kind
        self.url = url
        self.file = _file_from_url(url)
        self.inner = inner


def _parse_pool(root: ET.Element) -> dict[str, _Media]:
    pool: dict[str, _Media] = {}
    for el in root.iter():
        kind = _tag(el)
        if kind not in ("MusicClip", "AudioClip", "AudioPartClip"):
            continue
        media_id = _prop(el, "mediaID")
        if not media_id:
            continue
        url = ""
        for c in el:
            if _tag(c) == "Url":
                url = _prop(c, "url", "") or ""
                break
        inner: list[ET.Element] = []
        if kind == "AudioPartClip":
            holder = _attrs_with_id(el, "Events")
            if holder is not None:
                inner = _children(holder, "AudioEvent")
        pool[media_id] = _Media(kind, url, inner)
    return pool


# ------------------------------------------------------------------ 解析上下文

class _Ctx:
    """一次解析要带的东西：ZIP、媒体池、乐器通道表、速度、warnings 与统计。"""

    def __init__(self, zf: zipfile.ZipFile, pool: dict[str, _Media], song: ET.Element,
                 instruments: set[str], instruments_known: bool, ppq: float):
        self.zf = zf
        self.names = set(zf.namelist())
        self.pool = pool
        self.song = song
        self.instruments = instruments
        self.instruments_known = instruments_known
        self.ppq = float(ppq)
        self.tempo = _Tempo([(0.0, 120.0)], self.ppq)     # 真正的速度图由 _tempo() 填
        self.project: Project | None = None
        self.clip_index = 0
        self.missing_media: set[str] = set()
        self.dropped_notes = 0
        self.unreadable: set[str] = set()

    def next_clip_id(self) -> str:
        self.clip_index += 1
        return f"c{self.clip_index - 1}"

    def warn(self, text: str) -> None:
        if self.project is not None and text not in self.project.warnings:
            self.project.warnings.append(text)

    def media_path_exists(self, path: str) -> bool:
        return path.replace("\\", "/") in self.names

    def read_media(self, path: str) -> bytes | None:
        try:
            return self.zf.read(path.replace("\\", "/"))
        except (KeyError, OSError):
            return None


# ------------------------------------------------------------------ 轨道与片段

def _notes_of_part(data: bytes, offset: float, length: float, ctx: _Ctx) -> list[Note]:
    """一个 MusicPart 的音符：源坐标 -> 窗口内坐标（见文件头"片段是窗口"）。"""
    try:
        events = _music_events(data)
    except _ChunkError as exc:
        ctx.unreadable.add(str(exc))
        return []

    lo, hi = offset - EPS, offset + length + EPS
    notes: list[Note] = []
    for ev in events:
        # `quantize.start` / `quantize.velocity` 是宿主留下的**改动前记录**，不是要加上的
        # 偏移 —— 位置和力度都取文件里存的值。判据：M1 那条轨 160 个音符的
        # `velocity + quantize.velocity` 恒等于 0.6（= 宿主默认画音符的力度），
        # 说白了就是"当初画在 0.6，后来被改成了现在这个值"，`quantize.velocity` 记的是
        # 当初那个值。位置同理（那批音符的 `start + quantize.start` 落在节拍网格上，
        # 是量化之后又被手挪开之前的位置）。按"加上偏移"读，整份工程的力度会塌成
        # 76 / 102 两档（真值有 44 档）—— 用户对着 Studio One 一眼就看出来了。
        start = _num(ev.get("start"), 0.0)
        dur = _num(ev.get("length"), 0.0)
        end = start + dur
        if dur <= 0 or end <= lo or start >= hi:    # 窗口之外：Studio One 里不属于这个片段
            ctx.dropped_notes += 1
            continue
        # 裁到窗口边界（用精确边界，不用 EPS —— 否则音符会露到片段外面 1e-6 拍）
        rel_start = max(start, offset) - offset
        rel_end = min(end, offset + length) - offset
        length_tick = (rel_end - rel_start) * ctx.tempo.ppq
        if length_tick < 0.5:      # 不到半个 tick 的残片没有意义，直接丢
            ctx.dropped_notes += 1
            continue
        velocity = _num(ev.get("velocity"), 0.6)
        notes.append(Note(
            start_tick=round(rel_start * ctx.tempo.ppq, 6),
            length_tick=round(length_tick, 6),
            pitch=max(0, min(127, int(_num(ev.get("pitch"), 60)))),
            velocity=max(1, min(127, int(round(velocity * 127)))),
        ))
    notes.sort(key=lambda n: (n.start_tick, n.pitch))
    return notes


def _music_clip(ev: ET.Element, follow: str | None, ctx: _Ctx) -> Clip:
    start_tick = ctx.tempo.beat_to_tick(_num(_prop(ev, "start"), 0.0))
    length_tick = ctx.tempo.beat_to_tick(_num(_prop(ev, "length"), 0.0))   # MusicPart 一律 tf=2
    offset = _num(_prop(ev, "offset"), 0.0)
    name = _prop(ev, "name") or "MIDI 片段"
    clip_id = ctx.next_clip_id()

    notes: list[Note] = []
    media_id = _prop(ev, "clipID", "")
    media = ctx.pool.get(media_id) if media_id else None
    if media is None:
        ctx.missing_media.add(name)
    else:
        data = ctx.read_media(media.file)
        if data is None:
            ctx.missing_media.add(name)
        else:
            notes = _notes_of_part(data, offset, _num(_prop(ev, "length"), 0.0), ctx)
    return Clip(id=clip_id, name=name, kind="midi", start_tick=round(start_tick, 6),
                length_tick=round(length_tick, 6), notes=notes)


def _audio_clip(ev: ET.Element, follow: str | None, ctx: _Ctx,
                start_override: float | None = None,
                length_override: float | None = None) -> Clip:
    """音频片段。start/length 的换算见 `_Tempo.pos_to_tick` / `length_to_tick`。

    `start_override` / `length_override` 给"音频部件内部事件"用（位置相对部件起点）。
    """
    if start_override is None:
        start_tick = ctx.tempo.pos_to_tick(_num(_prop(ev, "start"), 0.0), follow)
    else:
        start_tick = start_override
    if length_override is None:
        length_tick = ctx.tempo.length_to_tick(
            _num(_prop(ev, "length"), 0.0), _prop(ev, "timeFormat"), start_tick)
    else:
        length_tick = length_override
    media_id = _prop(ev, "clipID", "")
    media = ctx.pool.get(media_id) if media_id else None
    audio_file = media.file if media is not None and media.url else None
    if audio_file is None and media_id and media is None:
        ctx.missing_media.add(_prop(ev, "name") or media_id)
    name = _prop(ev, "name") or (Path(audio_file).name if audio_file else "音频片段")
    return Clip(id=ctx.next_clip_id(), name=name, kind="audio",
                start_tick=round(max(0.0, start_tick), 6),
                length_tick=round(max(0.0, length_tick), 6), audio_file=audio_file)


def _part_clips(ev: ET.Element, follow: str | None, ctx: _Ctx) -> list[Clip]:
    """`AudioPartEvent`：部件本身没有音频，内部事件在媒体池的 AudioPartClip 里。"""
    part_start = ctx.tempo.pos_to_tick(_num(_prop(ev, "start"), 0.0), follow)
    media_id = _prop(ev, "clipID", "")
    media = ctx.pool.get(media_id) if media_id else None
    out: list[Clip] = []
    if media is not None and media.inner:
        for inner in media.inner:
            # 内部事件的位置相对部件起点，单位拍（实测这批都是 tf=2）
            rel = ctx.tempo.beat_to_tick(_num(_prop(inner, "start"), 0.0))
            length = ctx.tempo.length_to_tick(_num(_prop(inner, "length"), 0.0),
                                              _prop(inner, "timeFormat"), part_start + rel)
            out.append(_audio_clip(inner, follow, ctx, start_override=part_start + rel,
                                   length_override=length))
        return out
    ctx.warn(f"音频部件「{_prop(ev, 'name') or media_id}」在媒体池里没有内部音频事件，"
             f"只按部件本身画一个块")
    return [_audio_clip(ev, follow, ctx)]


def _events_of(track_el: ET.Element) -> list[ET.Element]:
    """轨道的全部事件：直接挂在 `List[id=Events]` 下，或分散在 `List[id=Layers]` 各层里。"""
    events: list[ET.Element] = []
    holder = _list_with_id(track_el, "Events")
    if holder is not None:
        events.extend(list(holder))
    layers = _list_with_id(track_el, "Layers")
    if layers is not None:
        for layer in layers:
            inner = _list_with_id(layer, "Events")
            if inner is not None:
                events.extend(list(inner))
    return events


def _channel_uid(track_el: ET.Element) -> str | None:
    for c in track_el:
        if _tag(c) == "UID" and _prop(c, "id") == "channelID":
            return _prop(c, "uid")
    return None


def _media_track(el: ET.Element, ctx: _Ctx, index: int) -> Track:
    number = _prop(el, "trackNumber", "?")
    name = _prop(el, "name") or ""
    media_type = _prop(el, "mediaType", "")
    follow = _prop(el, "tempoFollow")
    events = _events_of(el)

    clips: list[Clip] = []
    unknown = 0
    for ev in events:
        kind = _tag(ev)
        if kind == "MusicPart":
            clips.append(_music_clip(ev, follow, ctx))
        elif kind == "AudioEvent":
            clips.append(_audio_clip(ev, follow, ctx))
        elif kind == "AudioPartEvent":
            clips.extend(_part_clips(ev, follow, ctx))
        elif kind in ("Attributes", "UID", "SpeakerSetup", "List"):
            continue
        else:
            unknown += 1
    clips.sort(key=lambda c: c.start_tick)

    if media_type == "Music":
        if ctx.instruments_known:
            kind = "instrument" if _channel_uid(el) in ctx.instruments else "midi"
        else:
            kind = "instrument" if any(c.kind == "midi" for c in clips) else "midi"
    elif media_type == "Audio":
        kind = "audio"
    else:
        kind = "other"
        ctx.warn(f"第 {number} 轨的 mediaType=\"{media_type}\" 认不出来，按 other 画")
    if unknown:
        ctx.warn(f"轨「{name or number}」里有 {unknown} 个没认出来的事件，已跳过")
    return Track(id=f"t{index}", name=name or f"轨道 {number}", kind=kind, clips=clips)


# ------------------------------------------------------------------ 元信息

def _metainfo(root: ET.Element | None) -> dict[str, str]:
    out: dict[str, str] = {}
    if root is None:
        return out
    for el in root.iter():
        if _tag(el) == "Attribute":
            key = _prop(el, "id")
            if key:
                out[key] = _prop(el, "value", "") or ""
    return out


def _instruments(zf: zipfile.ZipFile, names: set[str]) -> tuple[set[str], bool]:
    """乐器通道的 uid 集合：`MusicTrackChannel` 带 `instrumentOut` 连接 = 有乐器。

    第二个返回值表示"设备信息读到了没有"——读不到就退回按有没有 MIDI 片段判断。
    """
    path = "Devices/musictrackdevice.xml"
    if path not in names:
        return set(), False
    try:
        root = _load_xml(zf.read(path))
    except (ET.ParseError, KeyError):
        return set(), False
    found: set[str] = set()
    for el in root.iter():
        if _tag(el) != "MusicTrackChannel":
            continue
        uid = next((_prop(c, "uid") for c in el
                    if _tag(c) == "UID" and _prop(c, "id") == "uniqueID"), None)
        if not uid:
            continue
        has_instrument = any(_tag(c) == "Connection" and _prop(c, "id") == "instrumentOut"
                             for c in el)
        if has_instrument:
            found.add(uid)
    return found, True


def _tempo(ctx: _Ctx) -> _Tempo:
    """`TempoMap` -> 速度图；表里 `tempo` 是"每四分音符多少秒"（spq）。"""
    segments: list[tuple[float, float]] = []
    node = next((e for e in ctx.song.iter() if _tag(e) == "TempoMap"), None)
    if node is not None:
        for seg in _children(node, "TempoMapSegment"):
            spq = _num(_prop(seg, "tempo"), 0.0)
            if spq <= 0:
                continue
            bpm = 60.0 / spq
            if BPM_MIN <= bpm <= BPM_MAX:
                segments.append((_num(_prop(seg, "start"), 0.0), bpm))
    segments.sort(key=lambda s: s[0])
    if not segments:
        ctx.warn("工程里没有能用的速度段，按 120 BPM 显示")
        segments = [(0.0, 120.0)]
    elif segments[0][0] > 0:
        segments.insert(0, (0.0, segments[0][1]))
    if len(segments) > 1:
        ctx.warn(f"速度图有 {len(segments)} 段，段间曲线（curveType）还没验证过，"
                 f"按阶梯（保持到下一个点）处理")
    return _Tempo(segments, ctx.ppq)


# ------------------------------------------------------------------ 主入口

def parse_song(path: str | Path) -> Project:
    path = Path(path)
    try:
        zf = zipfile.ZipFile(path)
    except (zipfile.BadZipFile, OSError) as exc:
        raise ValueError(f"{path.name} 不是 Studio One 工程文件（不是 ZIP）") from exc

    with zf:
        names = set(zf.namelist())
        if "Song/song.xml" not in names:
            raise ValueError(f"{path.name} 里没有 Song/song.xml —— 不是 .song 工程")
        meta = _metainfo(_load_xml(zf.read("metainfo.xml")) if "metainfo.xml" in names else None)
        song = _load_xml(zf.read("Song/song.xml"))
        pool = (_parse_pool(_load_xml(zf.read("Song/mediapool.xml")))
                if "Song/mediapool.xml" in names else {})
        instruments, known = _instruments(zf, names)

        ctx = _Ctx(zf, pool, song, instruments, known, PROJECT_PPQ)

        generator = meta.get("Document:Generator", "")
        host_version = generator.split("/", 1)[1] if "/" in generator else "unknown"
        project = Project(
            name=meta.get("Document:Title") or path.stem,
            host="studioone",
            host_version=host_version,
            ppq=PROJECT_PPQ,
            sample_rate=_num(meta.get("Media:SampleRate"), DEFAULT_SAMPLE_RATE),
        )
        ctx.project = project
        if host_version == "unknown":
            project.warnings.append("工程里没写 Studio One 版本号（Document:Generator）")
        if "Media:SampleRate" not in meta:
            project.warnings.append("工程里没写采样率，按 48000 显示")

        ctx.tempo = _tempo(ctx)
        project.tempo_map = normalize_tempo_map(ctx.tempo.points(), 120.0)
        project.bpm = project.tempo_map[0][1]

        sig = next((e for e in song.iter() if _tag(e) == "TimeSignatureMapSegment"), None)
        if sig is not None:
            num = int(_num(_prop(sig, "numerator"), 4))
            den = int(_num(_prop(sig, "denominator"), 4))
            if num > 0 and den > 0:
                project.time_sig = (num, den)

        project.markers = _markers(song, ctx)

        tracks_root = _find_by_id(song, "Tracks")
        if tracks_root is None:
            raise ValueError(f"{path.name} 里没找到轨道列表（List id=\"Tracks\"）")
        skipped = 0
        for el in tracks_root:
            kind = _tag(el)
            if kind == "MediaTrack":
                project.tracks.append(_media_track(el, ctx, len(project.tracks)))
            elif kind == "AutomationTrack":
                name = _prop(el, "name") or f"轨道 {len(project.tracks) + 1}"
                project.tracks.append(Track(id=f"t{len(project.tracks)}", name=name,
                                            kind="bus", clips=[]))
            elif kind in ("ChordTrack", "ArrangerTrack", "LyricsTrack", "VideoTrack",
                          "MarkerTrack"):
                skipped += 1
            else:
                ctx.warn(f"轨道列表里有没认出来的轨道类型「{kind}」，已跳过")
        if skipped:
            project.warnings.append(
                f"跳过了 {skipped} 条非内容轨（和弦 / 编曲 / 歌词 / 视频 / 标记轨）")

        if ctx.missing_media:
            names_preview = "、".join(sorted(ctx.missing_media)[:3])
            project.warnings.append(
                f"{len(ctx.missing_media)} 个片段在媒体池里找不到对应的演奏/音频文件"
                f"（{names_preview}…），这些片段只画色块、没有音符")
        if ctx.dropped_notes:
            project.warnings.append(
                f"{ctx.dropped_notes} 个音符落在片段的内容窗口之外（Studio One 里不属于"
                f"该片段），已跳过")
        if ctx.unreadable:
            project.warnings.append(
                f"{len(ctx.unreadable)} 个 MIDI 演奏文件读不动（{sorted(ctx.unreadable)[0]}）")

        end = 0.0
        for track in project.tracks:
            for clip in track.clips:
                end = max(end, clip.start_tick + clip.length_tick)
        if end:
            project.length_ticks = end + TAIL_BEATS * project.ppq
        return project


def _markers(song: ET.Element, ctx: _Ctx) -> list[list]:
    """`MarkerTrack` 下的 `MarkerEvent`（位置是拍；没有 start 属性 = 第 0 拍）。"""
    out: list[list] = []
    for el in song.iter():
        if _tag(el) != "MarkerTrack":
            continue
        for ev in _children(el, "MarkerEvent"):
            tick = ctx.tempo.beat_to_tick(_num(_prop(ev, "start"), 0.0))
            out.append([round(tick, 6), _prop(ev, "name", "") or ""])
    out.sort(key=lambda m: m[0])
    return out
