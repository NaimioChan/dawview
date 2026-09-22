"""Cubase .cpr parser (reverse-engineered against Cubase 15.0.30 / 15.0.21 WIN64).

Empirically verified layout — see docs/01-data-contract.md for the wire format.

Container      : 'RIF2' + 8-byte BE length + CmObject stream (plaintext).
Track          : attr record 'Name' -> u32 length + utf8 + NUL + BOM (EF BB BF);
                 track kind from the nearest class-name string before it.
Tempo (首拍)    : 'MusicalTempo' ... 'Float\\x00\\x00\\x04' + f64 BE bpm.
Tempo track    : 'MTempoTrackEvent' 之后是 [u32 条数][条数 × 22 字节]：
                   f32 BE 每四分音符秒数 (spq)  -> bpm = 60 / spq
                   f64 BE 该点起的绝对秒数
                   f64 BE 该点的绝对 tick
                   u16 BE 标志（实测恒为 0）
                 实测 1129 条；**阶梯语义**（相邻两点的实际间隔时间恒等于前一点的
                 spq，误差 1e-13 级 -> 速度保持到下一个事件，不做插值）。
Time signature : 'MusicalSignature' -> Numerator / Denominator as int64 BE.
MIDI part      : 'MMidiPart' class record, then u32 name-len + name + NUL + BOM.
                 一份工程里**只出现一次**（就是第一轨那个），不能当成"每个片段一个"来用：
                 音符是**按轨道对象分块**排布的 —— 某条轨道的音符紧跟它自己的轨道对象，
                 到下一条轨道对象为止。见 _notes_in()。
MIDI note      : <pos f64 BE ticks><u8 0><pitch u8><velocity u8> then a 2-char tag and
                 <'00 00 00 00 00 05' 'GLFX'> attribute bag:
                   Pler f64 (always 0.0 in practice), TDRH f64 = length in
                   QUARTER NOTES, VffO f64 = 恒为 0.5（不是力度！）,
                   adcn 32-byte expression blob.
                 力度就是 pitch 后面那个字节：实测与同工程的 MIDI note-on
                 事件（下面的 yTuc 记录）的 velocity 字节 1598/1674 逐点吻合。
MIDI CC        : yTuc 记录 = [u64=1][u8 状态][f64 BE tick][u8 0][u8 d1][u8 d2]，
                 状态 0xB0 = CC（d1 = CC 号，d2 = 值 0..127），
                 状态 0x90 = note-on（d1 = 音高，d2 = 力度）。
                 一份工程里 CC1 5271 点 / CC11 2715 点 / CC64 178 点。
Audio clip     : 'MAudioEvent' class record then f64 len-ticks, f64 source
                 offset (samples), f64 length (samples). Verified: at 76 BPM,
                 30 quarters -> 1136842.105 samples @48 kHz (exact match).

Known gaps (v0.3):
- Part start tick in the part header is not mapped yet; clip bounds are derived
  from note content (min pos .. max pos+len). The i64 pairs that follow a part
  name (e.g. 611/880) are object ids, not times: they stay constant across
  autosaves whose parts have very different lengths.
- Audio clip start tick not located; audio clips are placed at tick 0.
- CC 点按 tick 落进哪个 part 来归属（工程里通常只有一个 part，够用）；
  落在所有 part 之外的 CC 挂到最近的 part 上并夹进片段范围。
"""
from __future__ import annotations

import re
import struct
from pathlib import Path

from .model import Clip, Controller, Note, Project, Track, normalize_tempo_map

PPQ = 480
BOM = b"\xef\xbb\xbf"

# 常用 CC 的中文名（钢琴窗下部那栏直接显示这个）
CC_NAMES = {
    1: "调制轮", 2: "呼吸", 4: "脚踏", 5: "滑音时间", 7: "音量", 8: "平衡",
    10: "声像", 11: "表情", 64: "延音踏板", 65: "滑音踏板", 66: "持音踏板",
    67: "弱音踏板", 68: "连奏踏板", 71: "共鸣", 74: "明亮度", 84: "滑音控制",
    91: "混响", 92: "颤音深度", 93: "合唱", 94: "颤音延迟", 95: "相位",
    121: "复位控制器", 123: "全部音符关",
}

_TEMPO_CLASS = b"MTempoTrackEvent"
_YTUC_PAT = re.compile(rb"yTuc\x00\x01")

# 音符属性袋的标记。注意：pitch/velocity 就在标记前面两个字节，
# 旧写法把 pitch 也塞进正则的字符类（[\x20-\x90]）→ 低音区（pitch < 32，大提琴/低音提琴
# 的长音）会被整条漏掉。
_NOTE_TAG = re.compile(rb"\x00\x00\x00\x00\x00\x05GLFX")
_NAME_PAT = re.compile(
    rb"\x00\x00\x00\x05Name\x00\x00\x02\x00\x06\x00\x00\x00\x01"
    rb"\x00\x00\x00\x07String\x00\x00\x08"
)

_TRACK_CLASSES = (
    "MInstrumentTrackEvent", "MInstrumentTrack",
    "MMidiTrackEvent", "MidiTrack",
    "MAudioTrackEvent", "AudioTrack",
    "MFolderTrack", "FolderTrack",
    "MMarkerTrackEvent", "MarkerTrack",
    "MTempoTrackEvent", "TempoTrack",
    "MChordTrackEvent",
)


def parse_cpr(path: str | Path) -> Project:
    path = Path(path)
    data = path.read_bytes()
    if data[:4] not in (b"RIF2", b"RIFF"):
        raise ValueError(f"not a Cubase project file (magic={data[:4]!r})")

    project = Project(name=path.stem, host="cubase",
                      host_version=_find_host_version(data))
    project.bpm, project.time_sig = _find_tempo(data)
    project.sample_rate = _find_sample_rate(data)
    project.tracks = _find_tracks(data)

    tempo_points = _find_tempo_map(data)
    project.tempo_map = normalize_tempo_map(tempo_points, project.bpm)
    project.bpm = project.tempo_map[0][1]
    if len(project.tempo_map) > 1:
        project.warnings.append(f"速度轨：{len(project.tempo_map)} 个变速点（阶梯）")
    else:
        project.warnings.append("速度轨：只有一个速度，按定速播放")

    cc_events = _find_cc_events(data)
    for clip in _find_midi_clips(data, cc_events, tracks=project.tracks):
        _attach(project, clip)
    for clip in _find_audio_clips(data):
        _attach(project, clip)

    # 有 MIDI 片段却没认出种类的轨道，就是 MIDI/乐器轨（工程里不一定每条轨道都带
    # 类名记录：54 轨的工程里 MInstrumentTrackEvent 只出现一次）
    for t in project.tracks:
        if t.kind == "other" and t.clips:
            t.kind = "midi"

    for t in project.tracks:
        t.clips.sort(key=lambda c: c.start_tick)

    end = 0.0
    for t in project.tracks:
        for c in t.clips:
            end = max(end, c.start_tick + c.length_tick)
    if end:
        project.length_ticks = end + 4 * PPQ  # one bar of tail padding
    return project


# ------------------------------------------------------------------ helpers

def _find_host_version(data: bytes) -> str:
    m = re.search(rb"Version (\d+\.\d+\.\d+)", data)
    return m.group(1).decode() if m else "unknown"


def _find_tempo(data: bytes) -> tuple[float, tuple[int, int]]:
    bpm = 120.0
    i = data.find(b"MusicalTempo")
    if i != -1:
        m = re.search(rb"Float\x00\x00\x04", data[i:i + 400])
        if m:
            v = struct.unpack(">d", data[i + m.end():i + m.end() + 8])[0]
            if 20.0 <= v <= 400.0:
                bpm = v

    sig = (4, 4)
    i = data.find(b"MusicalSignature")
    if i != -1:
        w = data[i:i + 512]
        mn = re.search(rb"Numerator\x00\x00\x01", w)
        md = re.search(rb"Denominator\x00\x00\x01", w)
        if mn and md:
            num = int.from_bytes(w[mn.end():mn.end() + 8], "big", signed=True)
            den = int.from_bytes(w[md.end():md.end() + 8], "big", signed=True)
            if 0 < num <= 64 and 0 < den <= 64:
                sig = (num, den)
    return bpm, sig


def _find_sample_rate(data: bytes) -> float:
    """'AudioSampleRate' attribute: the f64 value sits ~67 bytes after the tag."""
    i = data.find(b"AudioSampleRate")
    if i == -1:
        return 44100.0
    for o in range(i, min(i + 200, len(data) - 8)):
        v = struct.unpack(">d", data[o:o + 8])[0]
        if v in (44100.0, 48000.0, 88200.0, 96000.0, 176400.0, 192000.0):
            return v
    return 44100.0


# --------------------------------------------------------------- 速度轨 / CC

_TEMPO_REC = 22
_CC_STATUS = 0xB0
_NOTEON_STATUS = 0x90


def _find_tempo_map(data: bytes) -> list:
    """Cubase 速度轨 -> [[tick, bpm], ...]（阶梯，契约 v0.3）。

    'MTempoTrackEvent' 后面紧跟 [u32 条数] + 条数 × 22 字节记录：
        f32 BE 每四分音符秒数 -> bpm = 60 / spq
        f64 BE 绝对秒数、f64 BE 绝对 tick、u16 BE 标志
    表头靠"首条记录必须 tick=0 / t=0 / spq 合理"自证，再顺着读；
    哪一条不自洽就停，避免读进后面的别的结构。
    """
    for m in re.finditer(re.escape(_TEMPO_CLASS), data):
        head = _tempo_head(data, m.end())
        if head is None:
            continue
        count, off = head
        points = _tempo_records(data, off, count)
        if len(points) >= 2:
            return points
    return []


def _tempo_head(data: bytes, start: int) -> tuple[int, int] | None:
    """在 start 之后 64 字节内找 [u32 条数][第一条记录] 的位置。"""
    for p in range(start, min(start + 64, len(data) - 4 - _TEMPO_REC)):
        count = int.from_bytes(data[p:p + 4], "big")
        if not (2 <= count <= 200000):
            continue
        rec = _tempo_record(data, p + 4)
        if rec is None:
            continue
        if rec[1] < 1e-6 and rec[2] < 1e-6:          # 第一条一定在工程开头
            return count, p + 4
    return None


def _tempo_record(data: bytes, off: int):
    if off + _TEMPO_REC > len(data):
        return None
    spq, t, tick, flags = struct.unpack_from(">fddH", data, off)
    if not (0.02 < spq < 20.0):
        return None
    if not (0.0 <= t < 1e7) or not (0.0 <= tick < 1e9) or flags != 0:
        return None
    return spq, t, tick, flags


def _tempo_records(data: bytes, off: int, count: int) -> list:
    points: list = []
    prev_tick = -1.0
    prev_t = -1.0
    for i in range(count):
        rec = _tempo_record(data, off + i * _TEMPO_REC)
        if rec is None:
            break
        spq, t, tick, _flags = rec
        if tick < prev_tick - 1e-6 or t < prev_t - 1e-6:     # 必须单调
            break
        prev_tick, prev_t = tick, t
        points.append([tick, 60.0 / spq])
    return points


def _find_cc_events(data: bytes) -> list:
    """yTuc 记录里的 CC 事件 -> [(位置, tick, cc, value), ...]（按 CC、tick 升序）。

    带上记录在文件里的位置：CC 也要按"离哪条轨道最近"归属（见 _assign_events），
    否则 28 条轨道各挂一遍全工程的 CC，总数会翻几十倍。

    记录布局：[u64 事件类别][u8 状态][f64 BE tick][u8 0][u8 d1][u8 d2]。
    只取 0xB0（CC）；0x90 是 note-on（力度已进音符），其余状态忽略。
    事件类别实测有 1 和 3（3 的 26 条也是合法 CC，按同一个 CC 号并进来）。
    """
    out: list = []
    for m in _YTUC_PAT.finditer(data):
        off = m.start()
        if off + 26 > len(data):
            continue
        if int.from_bytes(data[off + 6:off + 14], "big") not in (1, 3):
            continue
        if data[off + 14] != _CC_STATUS:
            continue
        tick = struct.unpack_from(">d", data, off + 15)[0]
        cc, value = data[off + 24], data[off + 25]
        if not (0.0 <= tick < 1e8) or not (0 <= cc <= 127) or not (0 <= value <= 127):
            continue
        out.append((off, tick, cc, value))
    out.sort(key=lambda e: (e[2], e[1]))
    return out


def _attach_controllers(clip: Clip, events: list) -> None:
    """把 CC 点挂到片段上（tick 相对片段起点，契约 v0.3）。

    按 tick 落点归属：落在片段范围内的收下；工程里只有一个 part 时，
    偶尔有 CC 落在片段范围外（比如第一个音之前踩的踏板），夹进片段
    保证不丢数据。
    """
    if not events:
        return
    lo = clip.start_tick
    hi = clip.start_tick + clip.length_tick
    by_cc: dict[int, list] = {}
    for tick, cc, value in events:
        if tick < lo - clip.length_tick * 0.5 or tick > hi + clip.length_tick * 0.5:
            continue                       # 明显不属于这个片段的（多 part 时）
        rel = min(max(tick - lo, 0.0), clip.length_tick)
        by_cc.setdefault(cc, []).append([rel, value])
    for cc in sorted(by_cc):
        points = sorted(by_cc[cc], key=lambda p: p[0])
        clip.controllers.append(Controller(cc=cc, points=points,
                                           name=CC_NAMES.get(cc, f"CC{cc}")))


def _named_payload(data: bytes, off: int, span: int = 64) -> tuple[str, int] | None:
    """After an object-class record, find the 'u32 len + utf8z + BOM' name field.

    Self-validating scan: a candidate length is accepted only when the bytes it
    covers really end in NUL followed by a UTF-8 BOM.
    """
    for p in range(off, min(off + span, len(data) - 8)):
        n = int.from_bytes(data[p:p + 4], "big")
        if not 3 < n < 256:
            continue
        end = p + 4 + n
        if end > len(data):
            continue
        # the declared length covers the NUL terminator AND the 3-byte BOM
        if data[end - 4] == 0 and data[end - 3:end] == BOM:
            name = data[p + 4:end - 4].decode("utf-8", "replace")
            return name, end
    return None


def _find_tracks(data: bytes) -> list[Track]:
    raw: list[tuple[int, str, str]] = []
    for m in _NAME_PAT.finditer(data):
        got = _named_payload(data, m.end(), span=8)
        if got is None:
            continue
        name = got[0]
        if not name:
            continue
        kind, _ = _class_before(data, m.start(), _TRACK_CLASSES, limit=4096)
        raw.append((m.start(), name, kind))

    # de-duplicate: the same name shows up twice (track object + child node) —
    # keep the most specific kind.
    best: dict[str, tuple[int, str]] = {}
    order: list[str] = []
    for off, name, kind in raw:
        if name not in best:
            order.append(name)
            best[name] = (off, kind)
        elif best[name][1] == "other" and kind != "other":
            best[name] = (off, kind)

    tracks: list[Track] = []
    for name in order:
        off, kind = best[name]
        t = Track(id=f"t{len(tracks)}", name=name, kind=kind)
        t._offset = off  # type: ignore[attr-defined]
        tracks.append(t)
    return tracks


def _class_before(data: bytes, off: int, classes, limit: int) -> tuple[str, int]:
    """Nearest known class-name string before `off` (within `limit` bytes)."""
    lo = max(0, off - limit)
    best = ("other", limit + 1)
    for cls in classes:
        j = data.rfind(cls.encode(), lo, off)
        if j != -1 and off - j < best[1]:
            best = (_kind_from_class(cls), off - j)
    return best


def _kind_from_class(cls: str) -> str:
    if "Instrument" in cls:
        return "instrument"
    if "Midi" in cls:
        return "midi"
    if "Audio" in cls:
        return "audio"
    if "Folder" in cls:
        return "folder"
    if "Marker" in cls:
        return "marker"
    if "Tempo" in cls:
        return "tempo"
    if "Chord" in cls:
        return "chord"
    return "other"


# -------------------------------------------------------------- clip finding

def _notes_in(data: bytes, lo: int, hi: int) -> list[Note]:
    """区间内的所有 MIDI 音符。

    记录布局（实测 Cubase 15.0.21 / 15.0.30）：
        <pos f64 BE ticks><u8 0><pitch u8><velocity u8> + b"\x00\x00\x00\x00\x00\x05GLFX"
    后面紧跟属性袋，其中 TDRH = 长度（四分音符）。
    交叉验证：按轨道分块解出来的音高范围与乐器吻合 ——
    低音提琴 36..60、大提琴 39..67、中提琴 51..85、小提琴 55..92、长笛 61..96。
    """
    out: list[Note] = []
    for m in _NOTE_TAG.finditer(data, lo, hi):
        p = m.start()
        if p < 16:
            continue
        pos = struct.unpack(">d", data[p - 11:p - 3])[0]
        pitch, vel = data[p - 2], data[p - 1]
        if not (0.0 <= pos < 10 ** 7 and 0 < pitch <= 127 and 0 < vel <= 127):
            continue
        tdrh = _attr_f64(data[p:p + 220], b"TDRH")
        if tdrh is None or not (0.0 < tdrh < 1024.0):
            continue
        out.append(Note(start_tick=pos, length_tick=tdrh * PPQ, pitch=pitch, velocity=vel))
    return out


# 普通名字记录：<u32 len+1><名字 utf8><NUL><BOM>（轨道对象、片段对象都带一个）
_NAME_REC = re.compile(rb"\x00\x00\x00([\x03-\x40])([^\x00]{3,63})\x00\xef\xbb\xbf")


def _assign_events(data: bytes, tracks: list[Track], cc_events: list):
    """把音符和 CC 事件一起归到轨道：跟着最近一个"名字等于某条轨道名"的名字记录走。

    为什么不按名字位置切区间：同一份工程里两种排布都有 —— 钢琴那条轨是
    "轨道对象 → 片段对象 → 名字 → 音符"，其余 53 条是"音符 → 名字记录"。
    按固定方向切会整体错位一条轨道（实测：第一轨吃到第二轨的 987 个音符）；
    按最近名字归属又会让"混响/编组"这类空轨抢走相邻轨道的音符（名字记录
    正好夹在两段音符中间）。扫一遍事件流、记住"当前片段属于谁"最稳。

    交叉验证：解出来的音高范围与乐器一致 —— 低音提琴 36..60、大提琴 39..67、
    中提琴 51..85、小提琴 55..92、长笛 61..96、钟琴 69..92。
    """
    by_name = {t.name: i for i, t in enumerate(tracks)}
    events: list[tuple[int, int, object]] = []       # (位置, 0=名字/1=音符/2=CC, 载荷)
    for m in _NAME_REC.finditer(data):
        # 声明的长度 = 名字 + NUL + 3 字节 BOM
        if len(m.group(2)) + 4 != m.group(1)[0]:
            continue
        nm = m.group(2).decode("utf-8", "replace")
        ti = by_name.get(nm)
        if ti is not None:
            events.append((m.end(), 0, ti))
    for m in _NOTE_TAG.finditer(data):
        events.append((m.start(), 1, m.start()))
    for off, tick, cc, value in cc_events or []:
        events.append((off, 2, (tick, cc, value)))
    events.sort()

    out: dict[int, list[Note]] = {}
    ccs: dict[int, list] = {}
    cur: int | None = None
    for _pos, kind, payload in events:
        if kind == 0:
            cur = payload            # type: ignore[assignment]
            continue
        if cur is None:
            continue
        if kind == 2:
            ccs.setdefault(cur, []).append(payload)
            continue
        p = payload                  # type: ignore[assignment]
        if p < 16:
            continue
        pos = struct.unpack(">d", data[p - 11:p - 3])[0]
        pitch, vel = data[p - 2], data[p - 1]
        if not (0.0 <= pos < 10 ** 7 and 0 < pitch <= 127 and 0 < vel <= 127):
            continue
        tdrh = _attr_f64(data[p:p + 220], b"TDRH")
        if tdrh is None or not (0.0 < tdrh < 1024.0):
            continue
        out.setdefault(cur, []).append(
            Note(start_tick=pos, length_tick=tdrh * PPQ, pitch=pitch, velocity=vel))
    return out, ccs


def _finish_clip(clip: Clip, cc_events: list) -> Clip | None:
    """音符齐了以后收尾：排序、算片段范围、挂 CC。"""
    if not clip.notes:
        return None
    clip.notes.sort(key=lambda n: n.start_tick)
    clip.start_tick = max(0.0, clip.notes[0].start_tick)
    hi = max(n.start_tick + n.length_tick for n in clip.notes)
    clip.length_tick = hi - clip.start_tick + PPQ  # one beat of slack
    _attach_controllers(clip, cc_events or [])
    return clip


def _find_midi_clips(data: bytes, cc_events: list | None = None,
                     tracks: list[Track] | None = None) -> list[Clip]:
    """每个轨道对象后面那段里的音符 = 这条轨道的 MIDI 片段。

    旧写法只认第一个 'MMidiPart'，然后把文件里**所有**音符都算进那一个片段：
    实测 54 轨的交响工程里，第一轨钢琴吃到 4313 个音符，其余 53 轨全空 —— 用户的
    报障就是它。改成按轨道分块之后，音符各归各轨。
    """
    cc = [(t, c, v) for _o, t, c, v in (cc_events or [])]
    clips: list[Clip] = []

    if tracks:
        per_track, ccs = _assign_events(data, tracks, cc_events)
        for ti, t in enumerate(tracks):
            notes = per_track.get(ti) or []
            if not notes:
                continue
            clip = Clip(id=f"c{ti}", name=t.name, kind="midi", start_tick=0.0, length_tick=0.0)
            clip.notes = notes
            got = _finish_clip(clip, [(tk, c, v) for tk, c, v in ccs.get(ti, [])])
            if got is not None:
                clips.append(got)
        if clips:
            return clips

    # 回退（找不到轨道对象时）：整文件扫一遍，按 MMidiPart 标记切段
    offsets = [m.start() for m in
               re.finditer(rb"\x00\x00\x00\x0aMMidiPart\x00\x00", data)]
    for idx, off in enumerate(offsets):
        region_end = offsets[idx + 1] if idx + 1 < len(offsets) else len(data)
        got = _named_payload(data, off + 14, span=48)
        name = got[0] if got else ""
        clip = Clip(id=f"c{off}", name=name or "(midi part)", kind="midi",
                    start_tick=0.0, length_tick=0.0)
        clip.notes = _notes_in(data, off, region_end)
        done = _finish_clip(clip, cc)
        if done is not None:
            clips.append(done)
    return clips


def _find_audio_clips(data: bytes) -> list[Clip]:
    """MAudioEvent -> audio clip.

    Three consecutive f64 BE fields follow the class record:
        [0] length in ticks   [1] start on the timeline, in SAMPLES
        [2] length in samples
    [0]/[2] self-calibrates the ticks-per-sample ratio, so [1] converts to a
    tick position without needing the sample rate or tempo.
    Verified on 26.9.16: 14400 ticks / 1136842.15 samples -> 1231578.99 samples
    = 15600.0 ticks exactly (76 BPM, 48 kHz).
    """
    clips: list[Clip] = []
    for m in re.finditer(rb"\x00\x00\x00\x0cMAudioEvent\x00\x00", data):
        found = None
        for o in range(m.end(), min(m.end() + 32, len(data) - 24)):
            v = struct.unpack(">d", data[o:o + 8])[0]
            if 1.0 <= v < 10 ** 7:          # skip denormal id bytes
                found = (o, v)
                break
        if found is None:
            continue
        o, len_ticks = found
        start_samples = struct.unpack(">d", data[o + 8:o + 16])[0]
        len_samples = struct.unpack(">d", data[o + 16:o + 24])[0]
        if not (1.0 <= len_samples < 10 ** 10 and 0.0 <= start_samples < 10 ** 12):
            continue
        start_tick = start_samples * (len_ticks / len_samples)

        name = "(audio)"
        got = _named_payload(data, max(0, m.start() - 512), span=480)
        if got:
            name = got[0]

        clips.append(Clip(id=f"a{m.start()}", name=name, kind="audio",
                          start_tick=start_tick, length_tick=len_ticks))
    return clips


def _attr_f64(window: bytes, tag: bytes) -> float | None:
    j = window.find(tag + b"\x00\x04")
    if j == -1:
        return None
    return struct.unpack(">d", window[j + 6:j + 14])[0]


def _attach(project: Project, clip: Clip) -> None:
    """Attach a clip to its track: by name first, then by kind."""
    for t in project.tracks:
        if t.name == clip.name:
            t.clips.append(clip)
            return
    want = ("midi", "instrument") if clip.kind == "midi" else ("audio",)
    for t in project.tracks:
        if t.kind in want:
            t.clips.append(clip)
            return
