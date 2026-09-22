"""FL Studio .flp parser (reverse-engineered against FL Studio 25.2.4.5242 / 24.1).

Empirically verified against real projects (万古城.flp 12 MB / 15971 events,
"piano practice 7.flp" FL 24.1). See docs/01-data-contract.md for the wire
format this produces.

Container   : 'FLhd' + u32 size(6) + <u16 format, u16 num_channels, u16 ppq>
              'FLdt' + u32 size + event stream (zlib-compressed projects start
              with 0x78; not seen in the sample, handled defensively).
Event       : 1-byte ID; the payload length is implied by the ID range
                ID <  64 : 1 byte
                ID < 128 : 2 bytes
                ID < 192 : 4 bytes
                ID >=192 : VarInt length, then that many bytes
              VarInt = 7 bits per byte, low group first, high bit = "more".
              Text payloads are UTF-16LE (FL >= 11.5) except FLVersion (ASCII).
Channel     : block starts at ID 64 (its u16 = channel index). A block that has
              a Type (21) is a real channel: name = 203, sample path = 196,
              internal name = 201 (empty for internal-controller automations).
              Types seen: 0 = stray block, 2 = native/VST instrument, 4 = Sampler
              / rendered audio clip (sample path present; items are audio clips),
              5 = automation channel ("Tempo" = 工程速度自动化，其余 = 插件参数).
Automation  : ID 234 on an automation channel = the curve:
                [u32 ×4][u8][u32 点数] then per point
                [f64 位置增量(四分音符)][f64 值 0..1][f32 tension][u32 标志],
                末尾 112 个未用字节。位置累加、实测量化到 1/4 四分音符
                （= 16 分音符）；值按被自动化参数的量程归一化。
Pattern     : block starts at ID 65 (u16 = pattern index, 1-based); notes = 224
              (24 bytes each, see _parse_notes), name = 193. Notes are relative
              to the pattern start.
Playlist    : ID 233, fixed records — the size depends on the FL version and is
              auto-detected (see _playlist_record_size): FL 25 = 80 bytes,
              FL 24 = 60 bytes, older = 32 bytes.
              Common prefix: position u32, pattern_base u16 (=20480),
              item_index u16, length u32, track_rvidx u16, group u16, ...
              In the 60-byte layout: flags u16 @22, then @24 either
                - pattern clip : u32 模式内起点 + u32 模式内终点 (ticks), or
                - audio / automation clip : f32 start_offset + f32 end_offset
                  (audio = 源文件毫秒，automation = 四分音符)
              实测：同一模式被两个片段按 [0,10368] / [10368,33432] 切成两段，
              两端长度正好等于片段长度 -> 这两个字段就是"片段播放模式里的哪一段"。
              item_index > 20480 -> pattern clip (pattern = item_index - 20480);
              otherwise it indexes a channel (audio clip / automation clip).
              track index = 499 - track_rvidx.
Track       : ID 238 starts a track block in playlist order (u32 = iid, 1-based);
              ID 239 = that track's name.
Tempo       : ID 156 = 工程速度 (BPM × 1000，实测 135000 -> 135.000 BPM)。
              FL 24+ 的变速是"Tempo"自动化通道的曲线（ID 234）+ 播放列表里
              引用该通道的片段；曲线的值按 FL 速度自动化片段的默认量程
              60–180 BPM 还原：bpm = 60 + 120 × value
              （实测曲线上的常驻值 0.625 ↔ 135.000 BPM，与 ID 156 吻合）。
              曲线在点之间是线性斜坡，而契约要求阶梯 -> 解析器按 1/16 拍加密。
              老工程没有 156 事件时退回"音频片段反推"：源文件时长(ms) /
              片段长度(tick) = 每 tick 毫秒数，众数 + 整数速度优先
              （万古城：557 个片段一致 3.612717 ms/tick = 173.000 BPM）。
Time sig    : ID 33 = numerator, 34 = denominator (the project-level marker).
Marker      : ID 148 = position, 205 = name. FL 25 packs flags into the high
              bits (sample: 0x08000300), so only the low 16 bits are used.

Known gaps (v0.3):
- CC 数据：FL 的 Pattern 不存 MIDI CC，契约里的 controllers 恒为空。
- 只有名字里带 "tempo" 的自动化通道会被当成工程速度（内部控制器自动化
  通道在文件里没有更明确的标识）。
- Sample rate is not stored in .flp files (44100 is reported).
"""
from __future__ import annotations

import collections
import statistics
import struct
import zlib
from pathlib import Path

from .model import Clip, Note, Project, Track, normalize_tempo_map

# --------------------------------------------------------------- event IDs
ID_TIME_SIG_NUM = 33
ID_TIME_SIG_DEN = 34
ID_CHAN_NEW = 64
ID_PAT_NEW = 65
ID_MARKER_POS = 148
ID_TEMPO = 156                # 工程速度，值 = BPM × 1000
ID_FL_BUILD = 159
ID_PAT_NAME = 193
ID_CHAN_SAMPLE = 196
ID_FL_VERSION = 199
ID_CHAN_INTERNAL = 201        # 内部名（插件名；内部控制器自动化是空的）
ID_CHAN_NAME = 203
ID_MARKER_NAME = 205
ID_PAT_NOTES = 224
ID_PLAYLIST = 233
ID_AUTOMATION = 234           # 自动化通道的曲线
ID_TRACK_DATA = 238
ID_TRACK_NAME = 239

PLAYLIST_RECORD = 80          # 兜底值；实际按版本自检（_playlist_record_size）
PLAYLIST_SIZES = (80, 60, 32)  # FL 25 / FL 24 / 更早
PATTERN_BASE = 20480          # item_index above this = pattern clip
PLAYLIST_TRACKS = 500         # track_rvidx is reversed: track = 499 - rvidx
CHANNEL_TYPES = {2: "audioclip", 4: "sampler", 5: "plugin"}
DEFAULT_SAMPLE_RATE = 44100.0
TEMPO_MIN, TEMPO_MAX = 60.0, 180.0   # FL 速度自动化片段的默认量程


def parse_flp(path: str | Path) -> Project:
    path = Path(path)
    raw = path.read_bytes()
    if raw[:4] != b"FLhd":
        raise ValueError(f"not an FL Studio project (magic={raw[:4]!r})")

    _fmt, num_channels, ppq = struct.unpack_from("<HHH", raw, 8)
    if raw[14:18] != b"FLdt":
        raise ValueError("FLdt chunk missing")
    size = struct.unpack_from("<I", raw, 18)[0]
    body = raw[22:22 + size]

    if body[:1] == b"\x78":                      # zlib (only if compressed)
        try:
            body = zlib.decompress(body)
        except zlib.error:
            pass

    project = Project(name=path.stem, host="fl", host_version="unknown",
                      ppq=ppq or 96, sample_rate=DEFAULT_SAMPLE_RATE)
    project.warnings.append("FL 工程不存采样率，按 44100 显示")

    channels: dict[int, dict] = {}
    patterns: dict[int, dict] = {}
    tracks: list[dict] = []
    markers: list[list] = []
    playlist = b""
    cur_chan: dict | None = None
    cur_pat = 1
    time_sig: tuple[int, int] | None = None
    tempo_event: float | None = None

    for eid, payload, _off in _events(body):
        if eid == ID_FL_VERSION:
            project.host_version = _text(payload, ascii_=True)
        elif eid == ID_FL_BUILD:
            pass
        elif eid == ID_TIME_SIG_NUM:
            num = payload[0]
            time_sig = (num, time_sig[1] if time_sig else 4)
        elif eid == ID_TIME_SIG_DEN:
            den = payload[0]
            time_sig = (time_sig[0] if time_sig else 4, den)
        elif eid == ID_TEMPO:
            if len(payload) >= 4:
                v = struct.unpack_from("<I", payload)[0] / 1000.0
                if 5.0 <= v <= 999.0:
                    tempo_event = v
        elif eid == ID_MARKER_POS:
            markers.append([struct.unpack_from("<I", payload)[0] & 0xFFFF, ""])
        elif eid == ID_MARKER_NAME:
            if markers and not markers[-1][1]:
                markers[-1][1] = _text(payload)
        elif eid == ID_CHAN_NEW:
            cur_chan = {"iid": struct.unpack_from("<H", payload)[0]}
            channels[cur_chan["iid"]] = cur_chan
        elif cur_chan is not None and eid == 21:
            cur_chan["type"] = payload[0]
        elif cur_chan is not None and eid == ID_CHAN_NAME and "name" not in cur_chan:
            cur_chan["name"] = _text(payload)
        elif cur_chan is not None and eid == ID_CHAN_SAMPLE and "sample" not in cur_chan:
            cur_chan["sample"] = _text(payload)
        elif cur_chan is not None and eid == ID_CHAN_INTERNAL and "internal" not in cur_chan:
            cur_chan["internal"] = _text(payload)
        elif cur_chan is not None and eid == ID_AUTOMATION and "automation" not in cur_chan:
            cur_chan["automation"] = _parse_automation(payload)
        elif eid == ID_PAT_NEW:
            cur_pat = struct.unpack_from("<H", payload)[0]
            patterns.setdefault(cur_pat, {})
        elif eid == ID_PAT_NAME:
            patterns.setdefault(cur_pat, {})["name"] = _text(payload)
        elif eid == ID_PAT_NOTES:
            patterns.setdefault(cur_pat, {})["notes"] = _parse_notes(payload)
        elif eid == ID_PLAYLIST:
            playlist = payload
        elif eid == ID_TRACK_DATA:
            iid = struct.unpack_from("<I", payload)[0] if len(payload) >= 4 else len(tracks) + 1
            tracks.append({"iid": iid, "name": ""})
        elif eid == ID_TRACK_NAME:
            if tracks:
                tracks[-1]["name"] = _text(payload)

    if time_sig:
        project.time_sig = time_sig
    project.markers = [[t, n] for t, n in markers if n]

    items, rec_size = _parse_playlist(playlist)
    if rec_size is None:
        project.warnings.append("播放列表记录长度认不出来，片段位置可能不准")
    base_bpm = tempo_event if tempo_event is not None else _derive_bpm(
        items, project.ppq, channels)
    if tempo_event is None:
        project.warnings.append(
            f"工程里没有速度事件（ID 156），用音频片段反推 {base_bpm:.3f} BPM")
    points, tempo_note = _tempo_map_from_channels(channels, items, project.ppq, base_bpm)
    project.tempo_map = normalize_tempo_map(points, base_bpm)
    project.bpm = project.tempo_map[0][1]
    project.warnings.append(tempo_note)

    # 只保留"有内容或有名字"的轨道：FL 固定写满 500 条，全画出来是 500 行空轨道
    named = {t["iid"] - 1: t["name"] for t in tracks}
    by_track: dict[int, list[dict]] = {}
    for it in items:
        by_track.setdefault(it["track"], []).append(it)

    for ti in sorted(set(by_track) | {k for k, v in named.items() if v}):
        name = named.get(ti) or ""
        clips = [_make_clip(it, channels, patterns, project) for it in by_track.get(ti, [])]
        clips = [c for c in clips if c is not None]
        if not clips and not name:
            continue
        clips.sort(key=lambda c: c.start_tick)
        kinds = {c.kind for c in clips}
        kind = kinds.pop() if len(kinds) == 1 else ("other" if kinds else "other")
        project.tracks.append(Track(
            id=f"t{len(project.tracks)}",
            name=name or f"轨道 {ti + 1}",
            kind=kind if kind in ("midi", "audio", "automation") else "other",
            clips=clips,
        ))

    end = 0.0
    for t in project.tracks:
        for c in t.clips:
            end = max(end, c.start_tick + c.length_tick)
    if end:
        project.length_ticks = end + 4 * project.ppq      # one bar of tail
    return project


# ------------------------------------------------------------------ event stream

def _events(data: bytes):
    """Yield (id, payload, offset) for every event in the FLdt chunk."""
    pos = 0
    n = len(data)
    while pos < n:
        off = pos
        eid = data[pos]
        pos += 1
        if eid < 64:
            size = 1
        elif eid < 128:
            size = 2
        elif eid < 192:
            size = 4
        else:
            size, pos = _varint(data, pos)
        yield eid, data[pos:pos + size], off
        pos += size


def _varint(data: bytes, pos: int) -> tuple[int, int]:
    value = 0
    shift = 0
    while pos < len(data):
        byte = data[pos]
        pos += 1
        value |= (byte & 0x7F) << shift
        if not byte & 0x80:
            break
        shift += 7
    return value, pos


def _text(payload: bytes, ascii_: bool = False) -> str:
    """FL >= 11.5 writes text as UTF-16LE; FLVersion is plain ASCII."""
    if ascii_:
        return payload.decode("latin-1", "replace").rstrip("\0")
    if len(payload) % 2 == 0:
        try:
            s = payload.decode("utf-16-le")
            if not s or s[0] != "\0":
                return s.rstrip("\0")
        except UnicodeDecodeError:
            pass
    return payload.decode("latin-1", "replace").rstrip("\0")


# ------------------------------------------------------------------ structures

def _parse_notes(payload: bytes) -> list[Note]:
    """24 bytes per note: position u32, flags u16, rack u16, length u32,
    key u16, group u16, fine u8, _u1 u8, release u8, midi_ch u8, pan u8,
    velocity u8, mod_x u8, mod_y u8."""
    notes: list[Note] = []
    for off in range(0, len(payload) - 23, 24):
        pos, _flags, _rack, length, key, _grp = struct.unpack_from("<IHHIHH", payload, off)
        vel = payload[off + 21]
        if not (0 <= key <= 127) or length <= 0:
            continue
        notes.append(Note(start_tick=float(pos), length_tick=float(length),
                          pitch=int(key), velocity=max(1, min(127, int(vel)))))
    notes.sort(key=lambda n: n.start_tick)
    return notes


def _parse_playlist(payload: bytes) -> tuple[list[dict], int | None]:
    """播放列表 -> ([片段...], 记录长度)。记录长度按版本自检（见 _playlist_record_size）。"""
    size = _playlist_record_size(payload)
    if size is None:
        return [], None
    items: list[dict] = []
    for off in range(0, len(payload) - size + 1, size):
        rec = payload[off:off + size]
        pos, _pbase, index, length, rvidx, _grp = struct.unpack_from("<IHHIHH", rec, 0)
        if not length:
            continue
        start_off, end_off = struct.unpack_from("<ff", rec, 24)
        item = {
            "track": PLAYLIST_TRACKS - 1 - rvidx,
            "position": pos,
            "length": length,
            "index": index,
            "start_offset": start_off,
            "end_offset": end_off,
        }
        # 模式片段：@24 那两个 u32 若自洽（区间长度 == 片段长度）就是
        # "本片段播放模式里的哪一段"（ticks）。f32 偏移读法不会凑巧满足这个等式。
        a, b = struct.unpack_from("<II", rec, 24)
        if index > PATTERN_BASE and 0 <= a < b <= 10 ** 7 and (b - a) == length:
            item["pattern_from"] = a
            item["pattern_to"] = b
        items.append(item)
    return items, size


def _playlist_record_size(payload: bytes) -> int | None:
    """给每种记录长度按"记录自洽度"打分，选最像的那个（>= 0.9 才算认出来）。

    实测：FL 24.1 的工程 240 字节 = 4 × 60（60 分制全对，80 分制只有 1/3 对）。
    """
    best_size, best_score = None, 0.0
    for size in PLAYLIST_SIZES:
        if len(payload) < size or len(payload) % size:
            continue
        n = len(payload) // size
        good = 0
        for i in range(n):
            rec = payload[i * size:(i + 1) * size]
            pos, pbase, index, length, rvidx, _grp = struct.unpack_from("<IHHIHH", rec, 0)
            if pbase != PATTERN_BASE:
                continue
            if not (0 < length < 10 ** 7 and pos < 10 ** 7 and rvidx < PLAYLIST_TRACKS):
                continue
            if not (PATTERN_BASE < index <= PATTERN_BASE + 999 or index < 5000):
                continue
            good += 1
        score = good / n
        if score > best_score + 1e-9:
            best_size, best_score = size, score
    return best_size if best_score >= 0.9 else None


def _make_clip(item: dict, channels: dict, patterns: dict, project: Project) -> Clip | None:
    pos, length, index = item["position"], item["length"], item["index"]
    if index > PATTERN_BASE:
        pat = index - PATTERN_BASE
        data = patterns.get(pat) or {}
        notes = list(data.get("notes") or [])
        pfrom, pto = item.get("pattern_from"), item.get("pattern_to")
        if pfrom is not None and pto is not None and notes:
            # 片段只播模式里的 [pfrom, pto) 这一段：音符要按段起点平移
            notes = [Note(start_tick=n.start_tick - pfrom,
                          length_tick=n.length_tick,
                          pitch=n.pitch, velocity=n.velocity)
                     for n in notes if pfrom <= n.start_tick < pto]
        if not notes:
            project.warnings.append(f"模式 {pat} 没有音符（片段 @tick {pos}）")
        return Clip(id=f"c{pos}.{index}", name=data.get("name") or f"Pattern {pat}",
                    kind="midi", start_tick=float(pos), length_tick=float(length),
                    notes=notes)

    chan = channels.get(index) or {}
    sample = chan.get("sample") or ""
    ctype = chan.get("type")
    if sample or ctype == 4:                      # Sampler / 渲染音频 -> 音频片段
        name = Path(sample.replace("\\", "/")).stem or chan.get("name") or f"音频 {index}"
        return Clip(id=f"c{pos}.{index}", name=name, kind="audio",
                    start_tick=float(pos), length_tick=float(length),
                    audio_file=sample or None)
    if ctype == 5:                                # 插件参数通道 -> 自动化片段
        return Clip(id=f"c{pos}.{index}", name=chan.get("name") or f"自动化 {index}",
                    kind="automation", start_tick=float(pos), length_tick=float(length))
    return Clip(id=f"c{pos}.{index}", name=chan.get("name") or f"片段 {index}",
                kind="other", start_tick=float(pos), length_tick=float(length))


# ------------------------------------------------------------ 速度自动化曲线

def _parse_automation(payload: bytes) -> list:
    """ID 234 的曲线 -> [(位置(四分音符), 值 0..1, tension), ...]（位置累加）。

    布局：[u32 ×4][u8][u32 点数] + 每点 24 字节
          [f64 位置增量][f64 值][f32 tension][u32 标志]，末尾 112 字节未用。
    """
    if len(payload) < 21:
        return []
    count = struct.unpack_from("<I", payload, 17)[0]
    if not (1 <= count <= 100000):
        return []
    out: list = []
    pos = 0.0
    off = 21
    for _ in range(count):
        if off + 24 > len(payload):
            break
        delta, value = struct.unpack_from("<dd", payload, off)
        tension = struct.unpack_from("<f", payload, off + 16)[0]
        off += 24
        if not (0.0 <= delta < 10 ** 7) or not (-0.01 <= value <= 1.01):
            break
        pos += delta
        out.append((pos, min(1.0, max(0.0, value)), tension))
    return out


def _curve_value(curve: list, pos: float) -> float | None:
    """曲线在位置 pos（四分音符）的值；点之间线性（FL 的 tension 忽略不计）。"""
    if not curve:
        return None
    if pos <= curve[0][0]:
        return curve[0][1]
    for i in range(len(curve) - 1):
        p0, v0, _t0 = curve[i]
        p1, v1, _t1 = curve[i + 1]
        if pos <= p1:
            if p1 <= p0:
                return v1
            return v0 + (v1 - v0) * (pos - p0) / (p1 - p0)
    return curve[-1][1]


def _curve_bpm(value: float) -> float:
    """曲线值 -> BPM：FL 速度自动化片段的默认量程是 60–180。"""
    return TEMPO_MIN + (TEMPO_MAX - TEMPO_MIN) * min(1.0, max(0.0, value))


def _collapse_steps(points: list) -> list:
    """丢掉连续相同值的台阶点（阶梯语义下值保持到下一个点，不影响结果）。"""
    out: list = []
    for tick, bpm in sorted(points, key=lambda p: p[0]):
        if out and abs(out[-1][1] - bpm) < 1e-6:
            continue
        out.append([tick, bpm])
    return out


def _curve_to_map(curve: list, clips: list, ppq: int) -> list:
    """曲线 + 引用它的播放列表片段 -> 阶梯变速点 [[tick, bpm], ...]。

    片段的 start_offset/end_offset 是**四分音符**（实测：与片段长度
    21936 tick / 480 = 228.5 四分音符 完全对得上），所以
    tick = 片段位置 + (曲线位置 - start_offset) × ppq。
    曲线本身是斜坡，这里按 1/16 拍补采样点，让阶梯贴住斜坡。
    """
    if not curve:
        return []
    if not clips:
        return [[pos * ppq, _curve_bpm(v)] for pos, v, _t in curve]

    points: list = []
    step = max(1.0, ppq / 4.0)
    for it in sorted(clips, key=lambda i: i["position"]):
        t0 = float(it["position"])
        t1 = t0 + float(it["length"])
        if t1 <= t0:
            continue
        p0 = float(it.get("start_offset") or 0.0)
        p1 = float(it.get("end_offset") or 0.0)
        if not (p1 > p0):
            p1 = p0 + (t1 - t0) / ppq
        ticks = {t0, t1}
        for pos, _v, _t in curve:
            if p0 < pos < p1:
                ticks.add(t0 + (pos - p0) * ppq)
        for k in range(int((t1 - t0) / step) + 1):
            ticks.add(t0 + k * step)
        for tick in sorted(ticks):
            v = _curve_value(curve, p0 + (tick - t0) / ppq)
            if v is not None:
                points.append([tick, _curve_bpm(v)])
    return _collapse_steps(points)


def _tempo_map_from_channels(channels: dict, items: list, ppq: int,
                             base_bpm: float) -> tuple[list, str]:
    """找"Tempo"自动化通道（内部控制器自动化）-> (变速点, 说明文字)。"""
    for iid, chan in sorted(channels.items()):
        if chan.get("type") != 5:
            continue
        curve = chan.get("automation") or []
        name = chan.get("name") or ""
        if not curve or "tempo" not in name.lower():
            continue
        clips = [it for it in items if it["index"] == iid]
        points = _curve_to_map(curve, clips, ppq)
        if not points:
            continue
        if points[0][0] > 0:
            points.insert(0, [0.0, base_bpm])
        where = f"{len(clips)} 个片段" if clips else "未放播放列表，按曲线位置直接用"
        return points, (f"速度自动化：{len(curve)} 点曲线 -> {len(points)} 个台阶点"
                        f"（{where}）")
    return [], "速度轨：没有速度自动化，按定速播放"


def _derive_bpm(items: list[dict], ppq: int, channels: dict) -> float:
    """ms-per-tick from the audio clips -> BPM (see module docstring).

    Only clips whose channel carries a sample path have a source duration;
    the ratio is bucketed and the winning bucket is refined by its median.
    Stretched loops keep their pack's tempo, so a candidate that lands on a
    whole BPM beats a bigger candidate that does not (万古城: 173.000 wins).
    """
    ratios: list[float] = []
    for it in items:
        chan = channels.get(it["index"]) or {}
        if not chan.get("sample") or it["length"] <= 0:
            continue
        source_ms = it["end_offset"] - max(0.0, it["start_offset"])
        if 0.0 < source_ms < 10 ** 7:
            ratios.append(source_ms / it["length"])
    if not ratios:
        return 120.0

    buckets = collections.Counter(round(r, 4) for r in ratios)
    best, count = buckets.most_common(1)[0]
    for ratio, n in buckets.most_common(8):
        if n < count * 0.25:
            break
        bpm = 60000.0 / (ratio * ppq)
        if abs(bpm - round(bpm)) <= 0.02:         # 整数速度优先
            best = ratio
            break

    tight = [r for r in ratios if abs(r - best) <= best * 0.001] or [best]
    bpm = 60000.0 / (statistics.median(tight) * ppq)
    if not 20.0 <= bpm <= 400.0:
        return 120.0
    return round(bpm, 3)
