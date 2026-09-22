"""FL Studio .flp parser (reverse-engineered against FL Studio 25.2.4.5242).

Empirically verified against a real 12 MB project (万古城.flp, 15971 events).
See docs/01-data-contract.md for the wire format this produces.

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
              a Type (21) is a real channel: name = 203, sample path = 196.
              Types seen (sample project): 0 = stray block, 2 = VST instrument
              (Serum, no playlist items), 4 = Sampler / rendered audio clip
              (sample path present; its items are audio clips), 5 = automation
              parameter channel ("Phaser - 扫描频率"; its items are automation
              clips, named after the automated parameter).
Pattern     : block starts at ID 65 (u16 = pattern index, 1-based); notes = 224
              (24 bytes each, see _parse_notes), name = 193. Notes are relative
              to the pattern start.
Playlist    : ID 233, fixed 80-byte records (FL 25; PyFLP's 32/60-byte layouts
              are older). Fields: position u32, pattern_base u16 (=20480),
              item_index u16, length u32, track_rvidx u16, group u16,
              u1(120,0), flags u16, u2(64,100,128,128), start_offset f32,
              end_offset f32, item_uid u32 (14075+), then 44 unused bytes.
              item_index > 20480 -> pattern clip (pattern = item_index - 20480);
              otherwise it indexes a channel (audio clip / automation clip).
              track index = 499 - track_rvidx.
Track       : ID 238 starts a track block in playlist order (u32 = iid, 1-based);
              ID 239 = that track's name.
Tempo       : **not stored** in FL 25 projects (no 156/66/93 events). Derived
              from the rendered audio clips: for an un-stretched clip the source
              duration (end_offset, milliseconds) over the clip length (ticks)
              is constant = ms per tick, so bpm = 60000 / (ratio * ppq).
              Only clips whose channel has a sample path count (automation clips
              have no source duration). Sample file: 557 clips agree on
              3.612717 ms/tick -> 173.000 BPM; the smaller clusters (171.37 /
              170.16 / 172.24) are tempo-stretched loops carrying their pack's
              own tempo, so an integer BPM wins over a slightly larger cluster.
Time sig    : ID 33 = numerator, 34 = denominator (the project-level marker).
Marker      : ID 148 = position, 205 = name. FL 25 packs flags into the high
              bits (sample: 0x08000300), so only the low 16 bits are used.

Known gaps (v0.2):
- Automation clips are recognised by their channel having no sample path; the
  curve data itself is not parsed (the contract has no automation field yet).
- Pattern clips whose start_offset trims into the pattern are placed correctly
  but their notes are not shifted.
- Sample rate is not stored in .flp files (44100 is reported).
"""
from __future__ import annotations

import collections
import statistics
import struct
import zlib
from pathlib import Path

from .model import Clip, Note, Project, Track

# --------------------------------------------------------------- event IDs
ID_TIME_SIG_NUM = 33
ID_TIME_SIG_DEN = 34
ID_CHAN_NEW = 64
ID_PAT_NEW = 65
ID_MARKER_POS = 148
ID_FL_BUILD = 159
ID_PAT_NAME = 193
ID_CHAN_SAMPLE = 196
ID_FL_VERSION = 199
ID_CHAN_NAME = 203
ID_MARKER_NAME = 205
ID_PAT_NOTES = 224
ID_PLAYLIST = 233
ID_TRACK_DATA = 238
ID_TRACK_NAME = 239

PLAYLIST_RECORD = 80
PATTERN_BASE = 20480          # item_index above this = pattern clip
PLAYLIST_TRACKS = 500         # track_rvidx is reversed: track = 499 - rvidx
CHANNEL_TYPES = {2: "audioclip", 4: "sampler", 5: "plugin"}
DEFAULT_SAMPLE_RATE = 44100.0


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

    items = _parse_playlist(playlist)
    project.bpm = _derive_bpm(items, project.ppq, channels)
    project.tempo_map = [[0, project.bpm]]

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


def _parse_playlist(payload: bytes) -> list[dict]:
    items: list[dict] = []
    for off in range(0, len(payload) - PLAYLIST_RECORD + 1, PLAYLIST_RECORD):
        pos, _pbase, index, length, rvidx, _grp = struct.unpack_from("<IHHIHH", payload, off)
        start_off, end_off = struct.unpack_from("<ff", payload, off + 24)
        if not length:
            continue
        items.append({
            "track": PLAYLIST_TRACKS - 1 - rvidx,
            "position": pos,
            "length": length,
            "index": index,
            "start_offset": start_off,
            "end_offset": end_off,
        })
    return items


def _make_clip(item: dict, channels: dict, patterns: dict, project: Project) -> Clip | None:
    pos, length, index = item["position"], item["length"], item["index"]
    if index > PATTERN_BASE:
        pat = index - PATTERN_BASE
        data = patterns.get(pat) or {}
        notes = list(data.get("notes") or [])
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
