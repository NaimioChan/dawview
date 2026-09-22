"""Cubase .cpr parser (reverse-engineered against Cubase 15.0.30 WIN64).

Empirically verified layout — see docs/01-data-contract.md for the wire format.

Container      : 'RIF2' + 8-byte BE length + CmObject stream (plaintext).
Track          : attr record 'Name' -> u32 length + utf8 + NUL + BOM (EF BB BF);
                 track kind from the nearest class-name string before it.
Tempo          : 'MusicalTempo' ... 'Float\\x00\\x00\\x04' + f64 BE bpm.
Time signature : 'MusicalSignature' -> Numerator / Denominator as int64 BE.
MIDI part      : 'MMidiPart' class record, then u32 name-len + name + NUL + BOM.
MIDI note      : <pos f64 BE ticks><pitch u8><pad 1> then a 2-char tag and
                 <'00 00 00 00 00 05' 'GLFX'> attribute bag:
                   Pler f64 (always 0.0 in practice), TDRH f64 = length in
                   QUARTER NOTES, VffO f64 = velocity ratio (0..1),
                   adcn 32-byte expression blob.
                 GLFX bags with a leading count of 3 (TDRH=1.0 + 'yTuc') are
                 controller/expression passes, not notes -> skipped.
Audio clip     : 'MAudioEvent' class record then f64 len-ticks, f64 source
                 offset (samples), f64 length (samples). Verified: at 76 BPM,
                 30 quarters -> 1136842.105 samples @48 kHz (exact match).

Known gaps (v0.2):
- Part start tick in the part header is not mapped yet; clip bounds are derived
  from note content (min pos .. max pos+len). The i64 pairs that follow a part
  name (e.g. 611/880) are object ids, not times: they stay constant across
  autosaves whose parts have very different lengths.
- Audio clip start tick not located; audio clips are placed at tick 0.
"""
from __future__ import annotations

import re
import struct
from pathlib import Path

from .model import Clip, Note, Project, Track

PPQ = 480
BOM = b"\xef\xbb\xbf"

_NOTE_PAT = re.compile(rb"[\x20-\x90][\x20-\x7f]\x00\x00\x00\x00\x00\x05GLFX")
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

    for clip in _find_midi_clips(data):
        _attach(project, clip)
    for clip in _find_audio_clips(data):
        _attach(project, clip)

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

def _find_midi_clips(data: bytes) -> list[Clip]:
    offsets = [m.start() for m in
               re.finditer(rb"\x00\x00\x00\x0aMMidiPart\x00\x00", data)]
    clips: list[Clip] = []
    for idx, off in enumerate(offsets):
        region_end = offsets[idx + 1] if idx + 1 < len(offsets) else len(data)
        got = _named_payload(data, off + 14, span=48)
        if got is None:
            continue
        name = got[0]
        clip = Clip(id=f"c{off}", name=name or "(midi part)", kind="midi",
                    start_tick=0.0, length_tick=0.0)

        for m in _NOTE_PAT.finditer(data, off, region_end):
            s = m.start()
            pos = struct.unpack(">d", data[s - 9:s - 1])[0]
            pitch = data[s]
            if not (0.0 <= pos < 10 ** 7 and 0 < pitch <= 127):
                continue
            window = data[s:s + 220]
            tdrh = _attr_f64(window, b"TDRH")   # length in quarter notes
            if tdrh is None or not (0.0 < tdrh < 1024.0):
                continue
            vffo = _attr_f64(window, b"VffO")
            vel = max(1, min(127, round((vffo if vffo is not None else 0.5) * 127)))
            clip.notes.append(Note(start_tick=pos, length_tick=tdrh * PPQ,
                                   pitch=pitch, velocity=vel))

        if not clip.notes:
            continue
        clip.notes.sort(key=lambda n: n.start_tick)
        clip.start_tick = max(0.0, clip.notes[0].start_tick)
        hi = max(n.start_tick + n.length_tick for n in clip.notes)
        clip.length_tick = hi - clip.start_tick + PPQ  # one beat of slack
        clips.append(clip)
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
