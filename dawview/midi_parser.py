"""标准 MIDI 文件 `.mid` / `.midi`（SMF 格式 0/1/2）解析器（实测 MuseScore 导出）。

实测工程：`projects/Spring Mpnody.mid`（MuseScore 导出的管弦乐，格式 1 / 39 条 MTrk /
ppq 480 / 33 条有音符的内容轨 + 5 条空轨 + 1 条走带轨 / 5346 个音符 /
216 个速度点 / 7 种 CC —— CC1 15911 点最多）。契约见 docs/01-data-contract.md。
解析结果与一份**逐字节独立扫描**（自己走一遍 delta + 运行状态）的计数逐项相同：
5346 个 note-on 全部配到 note-off、7 种 CC 的点数逐号一致、39 个块全部正好走满块长度
（`tests/test_midi_parser.py` 里那条断言就是这份独立扫描）。

======================= 容器 =======================
MIDI 文件是**大端 + 变长量**的二进制块流，没有 ZIP / XML 那层壳：

    MThd [u32 长度=6][u16 格式 0/1/2][u16 块数][u16 division]
    MTrk [u32 长度][事件流]
    MTrk ...（按格式：0 = 全部通道挤在一个块里；1 = 每块一条轨、速度在第一个块；
              2 = 各自独立的若干"歌"）

事件流里每个事件 = `[变长量 delta tick]` + `[状态字节 + 数据字节]`：
- **delta 是增量**，逐条累加成绝对 tick（和 REAPER `.rpp` 的 `E <偏移> ...` 同一套语义）
- **运行状态（running status）**：状态字节 < 0x80 表示"沿用上一个状态字节"，
  实测这份工程 30165 个事件里 19224 个（64%）走运行状态 —— 不支持它整份文件会读崩。
  `0xFF`（meta）与 `0xF0`/`0xF7`（sysex）**会清掉**运行状态（标准规定）。
- 状态：`0x8n` note-off / `0x9n` note-on（**力度 0 的 note-on 就是 note-off**）/
  `0xAn` 复音触后 / `0xBn` CC / `0xCn` 音色号 / `0xDn` 通道触后 / `0xEn` 弯音；
  `0xFF` meta（类型 + 变长量 + 内容）、`0xF0`/`0xF7` sysex（跳过）。
- meta 里用到的：`0x03` 轨名、`0x04` 音色名、`0x06` 标记、`0x51` 速度（**3 字节 = 每四分音符
  多少微秒**，bpm = 60000000 / 值）、`0x58` 拍号、`0x2F` 结束。

**division 是两种东西**：高位置 0 = 每四分音符 tick 数（`ppq`，这份工程 480，原样进契约）；
高位置 1 = SMPTE 计时（高字节是负的帧率、低字节是每帧 tick 数），这时 tick 不是"拍"而是
时间单位，契约的 tick 网格要另定（见 `_smpte_scale`）。

======================= 轨道 ↔ 契约的映射 =======================
MIDI 里**没有"片段"这一层**（不像 .cpr/.flp/.song 有 part / pattern / 窗口），
所以映射是：**一条 MTrk = 一条契约轨道，整条轨一个片段**（片段从 tick 0 铺到内容末尾）。
这也是宿主自己的习惯：Cubase / Studio One 导入 MIDI 就是"每轨一个部件"。

- 格式 0（一个块里塞了全部通道）→ **按通道拆**成多条契约轨道（`名字 · 通道 N`），
  这是唯一能还原"这是几件乐器"的办法。
- 轨道种类一律 `midi`：MIDI 文件里没有插件信息，"有没有挂乐器"无从判断（不像
  `.song` 能查 `instrumentOut`、`.rpp` 能查 FX 链）。
- **走带轨**（只有速度 / 拍号 / 轨名，一个通道事件都没有）不作为轨道显示 ——
  实测第一块就是这样，它的内容并进 `tempoMap` / `timeSig`。判据里的第二条：
  **没有名字又没有音符的空块**也一起跳过。反过来，**有名字但没有音符的轨（实测 5 条：
  Euphoniums / Cimbassos / Solo Contrabass Tuba / Marimba / Xylophone）保留成空行** ——
  它们在乐谱里是"这份编制有这件乐器，只是这段没演奏"，抹掉会让人以为编制少了。

======================= 音符 / CC =======================
- 音符 = note-on ↔ note-off 配对，按 **`(通道, 音高)` 各自一条先入先出队列**（同一条轨里
  同一个音高可以叠着按好几次，配错就整体错位）。力度取 note-on 的力度字节（1..127）。
- 长度 = 两个事件的 tick 差；同 tick 上开又关（长度 0）按 1 tick 画，免得在界面里消失。
- **没配到 note-off 的音符按该轨结束 tick 补齐**并记 warning（宿主没写完就存盘的文件不至于
  把音符整条丢掉）；配不到 note-on 的 note-off 直接跳过。
- **CC 进契约的 `controllers`**：按 `(通道, CC 号)` 归组成一条曲线，tick 相对片段起点
  （本格式片段起点就是 0，即绝对 tick）。实测这份工程 7 种 CC：CC1 调制轮 15911 点、
  CC11 表情 682、CC16 641、CC21 636、CC64 延音踏板 619、CC22 514、CC58 84。
- 音色号（`0xCn`）读得出来但契约里没有对应字段，**不出口**。

======================= 速度 / 拍号 / 标记 =======================
- `0x51` 速度点：三字节 big-endian 微秒 = bpm 的倒数。这份工程有 **216 个速度点**，
  前 1002 拍里每 240 tick（八分音符）一个 —— 是 MuseScore 把渐快渐慢的演奏速度
  写成了密集的速度点，契约 v0.3 的阶梯语义天然吃这套（一个点保持到下一个点）。
  **反算出来的 BPM 按 1e-3 收敛**：微秒那一格被宿主截断成整数（441176 微秒 = 136.000145 BPM），
  不收敛的话标题栏会显示 17 位小数；1e-3 BPM 在整首曲子里差不到 1 毫秒。
- **末尾那条坑**：MuseScore 会在**远超内容末尾**的 tick 上再写一条速度事件
  （实测内容到 264981 tick，它写在 1970304）。契约里没有内容的时间轴不显示，
  但状态栏的"时长"是按速度轨最后一个点算的 —— 留着会把 4 分钟的曲子显示成 34 分钟。
  所以**内容末尾之后的速度点丢掉**并记 warning（不是静默丢）。
- 拍号取第一个 `0x58`（分母是 2 的幂，`den = 1 << 字节`）；多个不同的拍号只 warn，
  契约里只有单值 `timeSig`（和别的宿主解析器一致）。
- 标记 `0x06` 收进 `markers`（这份工程没有）。

======================= 已知取舍 =======================
- **采样率不在文件里**：MIDI 只有事件，`sampleRate` 给默认 44100 并在 warnings 里说明。
- `hostVersion` 放 **SMF 格式号**（`SMF 1`）—— 文件里没有"宿主版本"这种东西，
  这一格空着不如放一个真实存在的格式标识。
- 静音 / 独奏 / 弯音 / 触后 / sysex / 速度曲线形状都不画（契约里没有对应字段）。
- SMPTE division 的文件：按标称速度（第一个速度点，没有就用 120）把 tick 重标到 480 ppq，
  秒数是对的，但速度曲线在那种文件里本来就不是"拍"的概念，只记一条 warning 说明。
- 不解析格式 2 的"多首歌"语义（按格式 1 一样每块一条轨处理，并 warn）。
"""
from __future__ import annotations

import struct
from pathlib import Path

from .model import CC_NAMES, Clip, Controller, Note, Project, Track, normalize_tempo_map

PROJECT_PPQ = 480             # SMPTE 计时重标用的 tick 密度（普通文件用文件里的 division）
DEFAULT_PPQ = 480             # division 写 0 时的兜底
DEFAULT_SAMPLE_RATE = 44100.0
DEFAULT_BPM = 120.0
BPM_DECIMALS = 3              # 反算出来的 BPM 收敛到几位小数（见文件头"速度"一节）
TAIL_BEATS = 4                # lengthTicks 在最后一段内容后留一小节
MIN_NOTE_TICKS = 1.0          # 长度 0 的音符按 1 tick 画

# 状态字节
NOTE_OFF, NOTE_ON, POLY_AFTERTOUCH = 0x80, 0x90, 0xA0
CONTROL_CHANGE, PROGRAM_CHANGE, CHANNEL_AFTERTOUCH, PITCH_BEND = 0xB0, 0xC0, 0xD0, 0xE0
META, SYSEX = 0xFF, 0xF0
SYSEX_ESC = 0xF7
DATA_WIDTH = {NOTE_OFF: 2, NOTE_ON: 2, POLY_AFTERTOUCH: 2, CONTROL_CHANGE: 2,
              PROGRAM_CHANGE: 1, CHANNEL_AFTERTOUCH: 1, PITCH_BEND: 2}
SYSTEM_WIDTH = {0xF1: 1, 0xF2: 2, 0xF3: 1}     # 系统公共事件的数据字节数（其余 0 字节）

# meta 类型
META_TEXT, META_TRACK_NAME, META_INSTRUMENT, META_MARKER = 0x01, 0x03, 0x04, 0x06
META_END, META_TEMPO, META_TIME_SIG = 0x2F, 0x51, 0x58

FORMAT_NAMES = {0: "单轨（全通道挤在一个块里）", 1: "多轨（速度在第一个块）", 2: "多首独立歌"}


class _MidiError(ValueError):
    """事件流读崩了（块长度对不上 / 状态字节非法 / 事件被截断）。"""


# ------------------------------------------------------------------ 基本读取

def _read_varint(data: bytes, pos: int) -> tuple[int, int]:
    """MIDI 的变长量：每字节低 7 位、高位续读，**最多 4 字节**（标准上限）。"""
    value = 0
    for _ in range(4):
        if pos >= len(data):
            raise _MidiError("变长量读到文件末尾")
        byte = data[pos]
        pos += 1
        value = (value << 7) | (byte & 0x7F)
        if not byte & 0x80:
            return value, pos
    raise _MidiError("变长量超过 4 字节")


def _text(raw: bytes) -> str:
    """meta 文本：实测宿主写 UTF-8，老文件有 latin-1 的，读不动就退回 latin-1。"""
    try:
        return raw.decode("utf-8")
    except UnicodeDecodeError:
        return raw.decode("latin-1")


# ------------------------------------------------------------------ 一条 MTrk

class _TrackData:
    """一条 MTrk 解出来的东西（还没进契约）。"""

    def __init__(self) -> None:
        self.notes: list[tuple[float, float, int, int, int]] = []   # start/end/pitch/vel/ch
        self.ccs: dict[tuple[int, int], list[list]] = {}            # (通道, CC) -> [[tick, 值]]
        self.tempos: list[tuple[float, int]] = []                   # (tick, 微秒/四分音符)
        self.sigs: list[tuple[float, int, int]] = []                # (tick, 分子, 分母)
        self.markers: list[tuple[float, str]] = []
        self.programs: dict[int, int] = {}
        self.name = ""
        self.instrument = ""
        self.channel_events = 0        # 通道事件数（0 = 走带 / 元信息块）
        self.channels: set[int] = set()
        self.end_tick = 0.0            # 结束事件（0x2F）的 tick，没有就是最后一个事件的 tick
        self.saw_end = False
        self.strays = 0                # 配不到 note-on 的 note-off
        self.unclosed = 0              # 到块尾还没关上的音符
        self.gaps = 0                  # 长度 0（同 tick 开又关）的音符
        self.leftover = 0              # 事件流走完多出来 / 少掉的字节


def _walk(payload: bytes, track: _TrackData) -> None:
    """走一遍 MTrk 事件流，把音符 / CC / 速度 / 标记收进 `track`。"""
    pos, tick, running, size = 0, 0.0, None, len(payload)
    open_notes: dict[tuple[int, int], list[list]] = {}      # (通道, 音高) -> [[起点, 力度]]

    while pos < size:
        delta, pos = _read_varint(payload, pos)
        tick += delta
        if pos >= size:
            break
        status = payload[pos]
        if status < 0x80:                  # 运行状态：沿用上一个状态字节
            if running is None:
                raise _MidiError(f"偏移 {pos} 的数据字节没有可继承的状态字节")
            status = running
        else:
            pos += 1
            if status < SYSEX:
                running = status

        if status == META:
            if pos >= size:
                raise _MidiError("meta 事件缺类型字节")
            mtype = payload[pos]
            pos += 1
            length, pos = _read_varint(payload, pos)
            body = payload[pos:pos + length]
            if len(body) < length:
                raise _MidiError(f"meta 0x{mtype:02x} 内容被截断")
            pos += length
            running = None                 # 标准：meta / sysex 之后不能继承运行状态
            if mtype == META_END:
                track.end_tick, track.saw_end = tick, True
                break
            elif mtype == META_TRACK_NAME and not track.name:
                track.name = _text(body).strip()
            elif mtype == META_INSTRUMENT and not track.instrument:
                track.instrument = _text(body).strip()
            elif mtype == META_MARKER:
                text = _text(body).strip()
                if text:
                    track.markers.append((tick, text))
            elif mtype == META_TEMPO and length >= 3:
                us = int.from_bytes(body[:3], "big")
                if us > 0:
                    track.tempos.append((tick, us))
            elif mtype == META_TIME_SIG and length >= 2:
                num, den = body[0], 1 << body[1]
                if num > 0 and den > 0:
                    track.sigs.append((tick, num, den))
            elif mtype == META_TEXT:
                # 只当轨名的兜底（有些导出只写一条 "Sequence/Track Name" 之外的文本事件）
                text = _text(body).strip()
                if text and not track.name:
                    track.name = text
            continue

        if status in (SYSEX, SYSEX_ESC):
            length, pos = _read_varint(payload, pos)
            pos += length
            running = None
            continue

        if status > SYSEX_ESC:             # 系统公共事件（MTC / 选歌 / 调音请求）不进契约
            pos += SYSTEM_WIDTH.get(status, 0)
            running = None
            continue

        width = DATA_WIDTH.get(status & 0xF0)
        if width is None:
            raise _MidiError(f"偏移 {pos} 上有认不出的状态字节 0x{status:02x}")
        body = payload[pos:pos + width]
        if len(body) < width:
            raise _MidiError(f"事件 0x{status:02x} 的数据字节被截断")
        pos += width
        channel = status & 0x0F
        track.channel_events += 1
        track.channels.add(channel)
        high = status & 0xF0

        if high == NOTE_ON and body[1] > 0:
            open_notes.setdefault((channel, body[0]), []).append([tick, body[1]])
        elif high == NOTE_OFF or high == NOTE_ON:          # 力度 0 的 note-on 也是 note-off
            queue = open_notes.get((channel, body[0]))
            if not queue:
                track.strays += 1
                continue
            start, velocity = queue.pop(0)
            length = tick - start
            if length <= 0:
                length = MIN_NOTE_TICKS
                track.gaps += 1
            track.notes.append((start, length, body[0], velocity, channel))
        elif high == CONTROL_CHANGE:
            track.ccs.setdefault((channel, body[0]), []).append([tick, body[1]])
        elif high == PROGRAM_CHANGE:
            track.programs[channel] = body[0]

    for (_channel, _pitch), queue in open_notes.items():    # 块尾还没关上的音符
        for start, velocity in queue:
            track.unclosed += 1
            length = max(MIN_NOTE_TICKS, track.end_tick - start)
            track.notes.append((start, length, _pitch, velocity, _channel))
    if not track.saw_end:
        track.end_tick = tick
    # 事件流应当正好走满块长度（0x2F 之后大多宿主会拿 0 填充，不算问题）
    tail = payload[pos:]
    if tail.strip(b"\x00"):
        track.leftover = len(tail)


# ------------------------------------------------------------------ 轨道 -> 契约

class _Row:
    """契约里的一条轨道（格式 0 时由代码按通道拆出来）。"""

    def __init__(self, name: str, notes: list, ccs: dict):
        self.name = name
        self.notes = notes
        self.ccs = ccs

    def content_end(self) -> float:
        end = 0.0
        for start, length, _pitch, _vel, _ch in self.notes:
            end = max(end, start + length)
        for points in self.ccs.values():
            if points:
                end = max(end, points[-1][0])
        return end


def _clip_of(row: _Row, clip_id: str) -> Clip:
    """整条轨一个片段：起点 0、长度到内容末尾，音符 / CC 的 tick 就是绝对 tick。"""
    notes = [Note(start_tick=round(start, 6), length_tick=round(length, 6),
                  pitch=max(0, min(127, pitch)), velocity=max(1, min(127, velocity)))
             for start, length, pitch, velocity, _ch in row.notes]
    notes.sort(key=lambda n: (n.start_tick, n.pitch))
    controllers = []
    for (_ch, cc), points in sorted(row.ccs.items()):
        points = sorted(points, key=lambda p: p[0])
        controllers.append(Controller(cc=cc, points=[[round(t, 6), v] for t, v in points],
                                      name=CC_NAMES.get(cc, f"CC{cc}")))
    return Clip(id=clip_id, name=row.name, kind="midi", start_tick=0.0,
                length_tick=round(row.content_end(), 6), notes=notes, controllers=controllers)


def _row_is_conductor(row: _Row, data: _TrackData) -> bool:
    """走带 / 元信息块：一个通道事件都没有，而且（写了速度 / 拍号，或者连名字都没有）。

    只看 `_Row.name` 不够 —— 没名字的块这时已经被兜底成了「轨道 N」；
    要看块里**原始**的轨名 / 音色名。
    """
    if row.notes or row.ccs or data.channel_events:
        return False
    if data.tempos or data.sigs:
        return True
    return not (data.name or data.instrument).strip()


# ------------------------------------------------------------------ SMPTE 重标

def _smpte_scale(division: int, bpm: float, ppq: int) -> tuple[float, float]:
    """SMPTE division -> (每秒多少 SMPTE tick, 重标到 `ppq` 网格的倍率)。

    高字节是**负的**帧率（补码），低字节是每帧 tick 数；这时 tick 是时间单位、不是拍，
    所以乘一个倍率把它换成"标称速度下 1 拍 = ppq tick"的网格（秒数因此是对的）。
    """
    fps = 256 - (division >> 8)
    per_frame = division & 0xFF
    if fps <= 0 or per_frame <= 0:
        raise _MidiError(f"SMPTE division 写坏了（0x{division:04x}）")
    ticks_per_second = float(fps * per_frame)
    return ticks_per_second, ppq * bpm / (60.0 * ticks_per_second)


# ------------------------------------------------------------------ 主入口

def parse_midi(path: str | Path) -> Project:
    path = Path(path)
    try:
        data = path.read_bytes()
    except OSError as exc:
        raise ValueError(f"{path.name} 读不动：{exc}") from exc

    warnings: list[str] = []

    def warn(text: str) -> None:
        if text not in warnings:
            warnings.append(text)

    if len(data) < 14 or data[:4] != b"MThd":
        raise ValueError(f"{path.name} 不是标准 MIDI 文件（开头没有 MThd 块）")
    header_len = struct.unpack_from(">I", data, 4)[0]
    if header_len < 6 or 8 + header_len > len(data):
        raise ValueError(f"{path.name} 的 MThd 块长度不对（{header_len} 字节）")
    fmt, n_chunks, division = struct.unpack_from(">HHH", data, 8)

    if fmt not in (0, 1, 2):
        warn(f"SMF 格式号 {fmt} 不认识，按格式 1 处理")
    if fmt == 2:
        warn(f"这是格式 2（{FORMAT_NAMES[2]}）的 MIDI，按格式 1 一样每块一条轨显示")

    # ---- 块：只认 MTrk，别的块（有的宿主塞自己的块）跳过
    pos, payloads = 8 + header_len, []
    while pos + 8 <= len(data):
        chunk_id = data[pos:pos + 4]
        chunk_len = struct.unpack_from(">I", data, pos + 4)[0]
        body = data[pos + 8:pos + 8 + chunk_len]
        if chunk_id == b"MTrk":
            payloads.append(body)
        elif chunk_id.strip(b"\x00"):
            warn(f"认不出的块「{chunk_id.decode('latin-1', 'replace')}」已跳过")
        pos += 8 + chunk_len
    if len(payloads) < n_chunks:
        warn(f"文件头说有 {n_chunks} 个 MTrk 块，实际只找到 {len(payloads)} 个")

    # ---- 一条一条块地解（单块失败不许拖垮整份文件）
    tracks: list[_TrackData] = []
    broken = 0
    for index, payload in enumerate(payloads):
        track = _TrackData()
        try:
            _walk(payload, track)
        except _MidiError:
            broken += 1
            if broken == 1:
                warn(f"第 {index + 1} 块的事件流读不动，整块跳过（块长度与实际事件对不上）")
            continue
        tracks.append(track)
    if broken:
        warn(f"一共 {broken} 个 MTrk 块读不动，已跳过")

    # ---- 速度 / 拍号 / 标记是全局的（任何一个块里都能写）
    tempos = sorted((tick, us) for track in tracks for tick, us in track.tempos)
    sigs = sorted((tick, num, den) for track in tracks for tick, num, den in track.sigs)
    markers = sorted((tick, text) for track in tracks for tick, text in track.markers)

    # ---- 采样率 / 速度提前定：SMPTE 重标要知道标称速度
    if division & 0x8000:
        nominal = 60000000.0 / tempos[0][1] if tempos else DEFAULT_BPM
        ppq = PROJECT_PPQ
        try:
            per_second, scale = _smpte_scale(division, nominal, ppq)
        except _MidiError as exc:
            raise ValueError(f"{path.name}：{exc}") from exc
        warn(f"这份 MIDI 用的是 SMPTE 计时（{per_second:.0f} tick/秒，不是拍），"
             f"已按标称 {nominal:.1f} BPM 重标到 {ppq} ppq 的网格 —— 秒数是对的，"
             f"速度曲线在这种文件里本来就不表示拍速")
        tempos = [(0.0, tempos[0][1] if tempos else int(60000000 / DEFAULT_BPM))]
    else:
        ppq = division or DEFAULT_PPQ
        scale = 1.0
        if not division:
            warn("文件头里的 division 写 0，按 480 ppq 显示")

    def scaled(tick: float) -> float:
        return tick * scale

    project = Project(
        name=path.stem,
        host="midi",
        host_version=f"SMF {fmt}",
        ppq=ppq,
        sample_rate=DEFAULT_SAMPLE_RATE,
    )
    warn("MIDI 文件里没有采样率（只有事件），按 44100 Hz 显示")

    # ---- 轨道
    conductor_name = ""
    if fmt != 0:
        for data in tracks:
            if not data.channel_events:
                conductor_name = conductor_name or data.name
    if conductor_name:
        project.name = conductor_name

    rows: list[tuple[_Row, _TrackData]] = []
    conductor_rows = 0
    if fmt == 0 and len(tracks) == 1:
        data = tracks[0]
        base = data.name or path.stem
        for channel in sorted(data.channels):
            rows.append((_Row(f"{base} · 通道 {channel + 1}",
                              [n for n in data.notes if n[4] == channel],
                              {k: v for k, v in data.ccs.items() if k[0] == channel}), data))
        if not data.channels:
            rows.append((_Row(base, [], {}), data))
    else:
        for index, data in enumerate(tracks):
            name = data.name or data.instrument or f"轨道 {index + 1}"
            rows.append((_Row(name, list(data.notes), dict(data.ccs)), data))

    kept: list[tuple[_Row, _TrackData]] = []
    for row, data in rows:
        if _row_is_conductor(row, data):
            conductor_rows += 1
            continue
        kept.append((row, data))
    if conductor_rows:
        warn(f"{conductor_rows} 条只有速度 / 拍号 / 轨名的走带（元信息）块不作为轨道显示，"
             f"它们的内容已并进工程全局信息")

    empty_kept = 0
    for index, (row, _data) in enumerate(kept):
        clip_id = f"c{index}"
        if scale != 1.0:
            row.notes = [(scaled(s), length * scale, p, v, c)
                         for s, length, p, v, c in row.notes]
            row.ccs = {k: [[scaled(t), v] for t, v in points] for k, points in row.ccs.items()}
        clips = [_clip_of(row, clip_id)] if (row.notes or row.ccs) else []
        if not clips:
            empty_kept += 1
        project.tracks.append(Track(id=f"t{index}", name=row.name, kind="midi", clips=clips))
    if empty_kept:
        warn(f"{empty_kept} 条轨在这份 MIDI 里没有音符（只有轨名），按空行显示")

    # ---- 速度轨：先按内容定长度，再把内容之后很远的速度点丢掉（见文件头说明）
    project.markers = [[round(scaled(tick), 6), text] for tick, text in markers]
    if sigs:
        first = sigs[0]
        project.time_sig = (first[1], first[2])
        if len({(num, den) for _t, num, den in sigs}) > 1:
            warn(f"工程里有 {len({(num, den) for _t, num, den in sigs})} 种拍号，"
                 f"契约里只有单值，按第一个 {first[1]}/{first[2]} 显示")
    else:
        warn("文件里没有拍号事件，按 4/4 显示")

    end = 0.0
    for track in project.tracks:
        for clip in track.clips:
            end = max(end, clip.start_tick + clip.length_tick)
    if end:
        project.length_ticks = end + TAIL_BEATS * ppq

    points = [(scaled(tick), round(60000000.0 / us, BPM_DECIMALS)) for tick, us in tempos]
    tempo_map = normalize_tempo_map(points, DEFAULT_BPM)
    if project.length_ticks:
        kept_points = [p for p in tempo_map if p[0] <= project.length_ticks]
        if len(kept_points) < len(tempo_map):
            warn(f"末尾 {len(tempo_map) - len(kept_points)} 个速度点落在内容之后很远的 tick 上"
                 f"（实测 MuseScore 导出会这么写：内容到 264981 tick，速度事件写到 1970304），"
                 f"已忽略 —— 留着会把状态栏的时长撑大")
        tempo_map = kept_points or [tempo_map[0]]
    if not tempos:
        warn("文件里没有速度事件，按 120 BPM 显示")
    project.tempo_map = tempo_map
    project.bpm = tempo_map[0][1]

    # ---- 零碎问题汇总（一条 warning 说一件事，别刷屏）
    strays = sum(t.strays for t in tracks)
    unclosed = sum(t.unclosed for t in tracks)
    gaps = sum(t.gaps for t in tracks)
    leftover = sum(t.leftover for t in tracks)
    if unclosed:
        warn(f"{unclosed} 个音符在文件里没写 note-off（块就结束了），按该轨末尾补齐长度")
    if strays:
        warn(f"{strays} 个 note-off 找不到对应的 note-on，已跳过")
    if gaps:
        warn(f"{gaps} 个音符的时长为 0（同 tick 上开又关），按 {MIN_NOTE_TICKS:.0f} tick 画")
    if leftover:
        warn(f"{leftover} 个字节的事件流对不上块长度（多出非 0 内容），已忽略")

    project.warnings.extend(warnings)
    return project
