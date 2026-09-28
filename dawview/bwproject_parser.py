"""Bitwig Studio `.bwproject` parser (reverse-engineered against Bitwig 5.3.13).

实测工程："25.6.30 house.bwproject"（31 轨 / 2502 音符 / 548 个音频样本记录）。
本文件是线格式（wire format）笔记的权威位置，契约见 docs/01-data-contract.md。

======================= 容器 =======================
文件 = [BtWg 文档段][若干嵌入子文档][ZIP（插件状态 / 预览音频）]
开头：`BtWg` + 10 位 ASCII 版本号（"0003000200"）；
随后 [u32 块数][u32 块名长]"meta"，然后一条条 meta：
    [u32 1][u32 keyLen][key utf8][u8 tag][payload]
    tag 0x08 → [u32 len][utf8]      字符串
    tag 0x03 → [u32]                整数
    tag 0x0d → [u32 len][bytes]     blob（"structure" 就是**嵌入的摘要文档**）
    tag 0x19 → [u32 count][u32 len][utf8]...   字符串列表
    [u32 0] 收尾，之后是空格（0x20）填充到文档段起点。
meta 里有用的是：application_version_name（宿主版本）、creator、revision_no。

======================= 文档 =======================
文档体 = [0x0a][u32 根对象 class] + 元素流。**每个元素**：
    [6B 头标记 00 00 01 fd 01 00 —— 或全 0（"与上一个元素同构"的增量写法）]
    [u32 字段号][u8 tag=0x12 —— 或 0x00（同上增量）][u32 class]
    （class 始终在元素起点 +11 .. +14，两种写法都一样）
还有**最紧凑的头**：[u32 0][u8 0x00][u32 class]，连 6B 头标记都没有 —— 复制粘贴出来的
片段元素就是这么写的，只认"POS 在元素头 +15"的锚点扫描会漏掉它们
    之后是该元素的字段流。
字段 = [u32 id][u8 tag][payload]；tag → payload 长度：
    0x01/0x05/0x11 = 1B   0x02 = 2B   0x03/0x04/0x06/0x09/0x0b/0x0c/0x12 = 4B
    0x07 = f64(BE)        0x08 = [u32 len]utf8    0x0d = [u32 len]bytes
    0x0a = 0B（引用）     0x15 = 8B   0x19 = [u32 count]
    流里还会出现 4 字节全 0（空槽 / 列表分隔）。
实测字段（**0x2af 永远紧跟元素头 +15 处，用它当元素锚点**）：
    0x2af f64  位置（拍 = 四分音符；音符是相对片段起点）
    0x26  f64  长度 / 时值（拍）
    0xef  f64  音符力度 0..1           0xf0 f64 释放力度
    0x2dfc f64 概率 0..1（实测 1.0）
    0xee  u8   音符轨（piano-roll lane）音高，在 **class 0x42** 元素里
    0x129f / 0x512 utf8  音频文件名（在 class 0xd4 元素里，两条一样）
    0x236 utf8 片段名（写在**片段元素自己的字段区**里，紧跟 POS 之后；别去抓元素头
              前面那几十个字节，那是宿主对象自己的名字，实测全是 "Untitled"）
    0x2c8 f64  速度 BPM（在名字叫 "TEMPO" 的 class 0x2bd 元素里）
    0x238 u32  **轨道片段列表头**（每轨一份，顺序同摘要；见下面"片段实例"）
    0x288 u32  片段字段区里的宿主 class：0xbf = 乐器轨、0x105 = 音频轨（用来定片段类型）
元素 class（实测）：0x47 = MIDI 片段内容对象(11，带完整头的那种)
    0x42 = 音符轨/lane  0x66 = MIDI 音符(2502)  0xee = 音频片段  0xd4 = 音频样本记录
    0x43 = 片段端点标记  0x108 / 0x203 / 0x7d / 0x60b(1，DUR=208 拍 = 工程末尾) 未认出来
**片段实例**（走带上的片段，含复制粘贴出来的副本）不走"带头标记的元素"那条路：
文档里每条轨道有一份"片段列表头"字段 (0x238, tag 0x09)（31 轨 31 份，顺序同摘要），
每个片段实例带 (0x288, tag 0x09, 0xbf/0x105)；按"离它最近的、排在它前面的列表头"归轨。
实测：11 个片段内容对象 → **44 个 MIDI 片段实例 + 548 个音频片段实例**。
乐器段的列表头逐轨一份（没片段的轨也是空的）；音频段是"能放音频的轨按顺序一份"，
所以音频段按摘要里混合轨（class 0x287）的顺序对齐。
音频片段的采样名只在**每组第一段的样本记录**里出现，后面的记录没有 → 顺着往前补。
嵌入的**摘要文档**（meta 的 "structure" blob）：只有轨道清单，写成
    (0xace, tag 0x12, class 0x288) / [u32 0][u32 class] + (0xad1, utf8 轨道名)
class：0x288 = 乐器轨  0x287 = 音频轨  0x28a = FX 返回轨  0x28b = Master
摘要里第一个对象是工程根本身（class 0x283，名字 "Project"），不算轨道。

======================= 已知缺口 =======================
- 音频片段的轨道归属：乐器段按片段列表头逐轨对齐（可靠）；音频段按"混合轨顺序"对齐，
  组数与混合轨数对不上时退回按列表头顺序并在 warnings 里说明。
- class 0x43 / 0x108 / 0x203 / 0x7d 的语义没认出来（0x43 成对出现在音频样本前后，
  疑似淡入淡出端点），这些数据不进契约。
- 拍号没找到存放处，恒按 4/4 给出（warnings 里说明）。
- 采样率不在工程文件里（Bitwig 存在偏好设置里），固定 44100。
- 速度图（多速度点）没逆向，按首速恒定。
"""
from __future__ import annotations

import bisect
import struct
from pathlib import Path
from typing import Any

from .model import Clip, Note, Project, Track, normalize_tempo_map

MAGIC = b"BtWg"

# ---- 字段 payload 长度表（tag → 长度；str/blob/arr 另行处理） ----
FIXED = {0x01: 1, 0x02: 2, 0x03: 4, 0x04: 4, 0x05: 1, 0x06: 4, 0x09: 4,
         0x0B: 4, 0x0C: 4, 0x11: 1, 0x12: 4, 0x15: 8}
TAG_STR, TAG_BLOB, TAG_REF, TAG_ARR, TAG_F64 = 0x08, 0x0D, 0x0A, 0x19, 0x07

# ---- 元素 class ----
CLS_MIDI_CLIP = 0x47
CLS_LANE = 0x42
CLS_NOTE = 0x66
CLS_AUDIO_CLIP = 0xEE
CLS_AUDIO_SAMPLE = 0xD4
CLS_AUDIO_LANE = 0xCE
CLS_MARKER_PAIR = 0x43

LANE_CLASSES = (CLS_LANE, CLS_AUDIO_LANE)
# 会“打断”lane 的元素种类 —— lane 里嵌着片段/音符，lane 的内容到这些为止
BOUNDARY_CLASSES = (CLS_MIDI_CLIP, CLS_LANE, CLS_AUDIO_LANE, CLS_AUDIO_CLIP)

MARKER6 = b"\x00\x00\x01\xfd\x01\x00"
POS_ID = b"\x00\x00\x02\xaf\x07"          # 位置字段字节序：元素起点 +15
PITCH_FOOTER = b"\x00\x00\x00\xee\x01"   # 音高轨 footer：字段 0xee + tag 0x01，后一字节 = MIDI 音高
CHANCE_ID = b"\x00\x00\x2d\xfc"          # 每个音符记录的锚点字段号（0x2dfc = 概率）
LANE_ID = b"\x00\x00\x18\xcb\x12"        # 音符/音频轨（lane）元素：字段号 0x18cb + tag 0x12
HDR = 15

# ---- 走带片段（含复制粘贴出来的副本）----
# 每个轨道在文档里有一份"片段列表"头：字段 (0x238, tag 0x09)，31 条轨道 31 个，顺序与摘要一致。
TRACK_SLOT_ID = b"\x00\x00\x02\x38\x09"
# 每个片段对象的字段区里带 (0x288, tag 0x09, 宿主 class)：0xbf=乐器轨、0x105=音频轨。
# **复制粘贴出来的每一段都是独立片段对象**，位置/时长是它字段区的头两个 f64 —— 早期版本
# 只认带完整元素头的片段，于是"每轨只剩一段"。
CLIP_OWNER_ID = b"\x00\x00\x02\x88\x09"
CLIP_OWNER_MIDI, CLIP_OWNER_AUDIO = 0xBF, 0x105
CLIP_PROLOGUE = 32                       # 位置字段到"宿主 class"字段的固定距离

# ---- 字段号 ----
F_POS, F_LEN = 0x2AF, 0x26
F_VEL, F_RELVEL, F_CHANCE = 0xEF, 0xF0, 0x2DFC
F_PITCH = 0xEE
F_AUDIO_NAME = (0x129F, 0x512)
F_NAME = 0x236
F_BPM = 0x2C8
F_TEMPO_NAME = 0x2BD
F_PROJECT_NAME = 0x44

# ---- 摘要里的轨道 class ----
# 0x288 = 乐器轨；0x287 = 混合轨（既能放 MIDI 片段也能放音频片段，实测鼓组轨和音频轨
# 都是它）；0x28a/0x28b = 总线。混合轨按**实际放了什么片段**再定 kind（见 parse 结尾）。
TRACK_KIND = {0x288: "instrument", 0x287: "midi", 0x28A: "bus", 0x28B: "bus"}
HYBRID_CLASS = 0x287         # 混合轨：既能放 MIDI 片段也能放音频片段
ROOT_CLASS = 0x283          # 摘要里第一个对象 = 工程根，不是轨道

PPQ = 480                   # dawview 的 tick 分辨率（Bitwig 内部一律存"拍"）


def _u32(d: bytes, o: int) -> int:
    return struct.unpack_from(">I", d, o)[0]


def _f64(d: bytes, o: int) -> float:
    return struct.unpack_from(">d", d, o)[0]


# --------------------------------------------------------------- meta 块

def _parse_meta(d: bytes) -> tuple[dict[str, Any], int]:
    """解析 meta 块，返回 (键字典, 文档段起点)。"""
    if not d.startswith(MAGIC):
        raise ValueError("不是 Bitwig 工程（缺少 BtWg 魔数）")
    off = 0x2A
    off += 4                                  # 块计数（实测恒 4，不必校验）
    klen = _u32(d, off)
    off += 4 + klen                           # 块名（"meta"）
    meta: dict[str, Any] = {}
    while off + 4 <= len(d):
        flag = _u32(d, off)
        if flag == 0:
            off += 4
            break
        off += 4
        klen = _u32(d, off)
        off += 4
        key = d[off:off + klen].decode("utf-8", "replace")
        off += klen
        tag = d[off]
        off += 1
        if tag in (TAG_STR, TAG_BLOB):
            ln = _u32(d, off)
            off += 4
            meta[key] = (tag, d[off:off + ln])
            off += ln
        elif tag == 0x03:
            meta[key] = (tag, _u32(d, off))
            off += 4
        elif tag == TAG_ARR:
            cnt = _u32(d, off)
            off += 4
            items = []
            for _ in range(cnt):
                ln = _u32(d, off)
                off += 4
                items.append(d[off:off + ln].decode("utf-8", "replace"))
                off += ln
            meta[key] = (tag, items)
        else:
            raise ValueError(f"meta 条目 {key!r} 的 payload tag {tag:#04x} 不认识")
    while off < len(d) and d[off] == 0x20:     # 空格填充到文档段
        off += 1
    return meta, off


def _text(blob: bytes) -> str:
    return blob.decode("utf-8", "replace")


_NORM_RE = None


def _norm(s: str) -> str:
    """归一化名字用于比对：去掉大小写、空格、下划线、连字符等噪声。"""
    global _NORM_RE
    if _NORM_RE is None:
        import re
        _NORM_RE = re.compile(r"[^0-9a-z]+")
    return _NORM_RE.sub("", s.lower())


def _parse_summary(blob: bytes) -> list[tuple[int, str]]:
    """解析摘要文档，按顺序返回 [(class, 名字)]；第一个是工程根对象。"""
    if not blob.startswith(MAGIC):
        raise ValueError("摘要文档不是 BtWg")
    o = 0x2A + 1                              # 跳过文档体版本字节 0x0a
    o += 4                                    # 根对象 class
    out: list[tuple[int, str]] = []
    cur_cls = 0
    end = len(blob) - 4
    while o < end:
        ident = _u32(blob, o)
        tag = blob[o + 4]
        if tag == TAG_STR:
            ln = _u32(blob, o + 5)
            val = blob[o + 9:o + 9 + ln]
            o += 9 + ln
            if ident == 0xAD1:                # 轨道名
                out.append((cur_cls, _text(val)))
        elif tag == 0x12:                     # 对象声明（带字段号）
            cur_cls = _u32(blob, o + 5)
            o += 9
        elif tag == 0x09:
            if ident == 0xAD2:                # 根对象的 class 写在这个字段里
                cur_cls = _u32(blob, o + 5)
            o += 9
        elif tag == 0x00 and ident == 0:      # 增量写法：[u32 0][u32 class]
            nxt = _u32(blob, o + 4)
            if 0x100 <= nxt <= 0xFFFF:
                cur_cls = nxt
            o += 8
        elif tag == 0x01:
            o += 6
        else:
            break
    return out


# --------------------------------------------------------------- 字段 / 元素

def _elem_class(d: bytes, o: int) -> int | None:
    """判断 o 处是不是一个元素头，是的话返回它的 class。

    元素头 = [6B 头标记 00 00 01 fd 01 00 或 11 个 0] + [u32 字段号][u8 tag][u32 class]。
    注意 **同一串 6 字节也会作为普通字段** 出现在元素内部（字段 0x1fd = 列表分隔），
    所以还要看 tag 和 class 是否合理，否则会把元素内部的分隔符当成新元素。
    """
    if o + 15 > len(d):
        return None
    if not (d[o:o + 6] == MARKER6 or d[o:o + 11] == b"\x00" * 11):
        return None
    if d[o + 10] not in (0x12, 0x00):
        return None
    cls = _u32(d, o + 11)
    return cls if 0x02 <= cls <= 0x8000 else None


def _field_end(d: bytes, off: int, stop: int) -> int:
    """读一个字段，返回结束偏移；读不动返回 -1。"""
    if off + 5 > stop:
        return -1
    tag = d[off + 4]
    if tag in FIXED:
        end = off + 5 + FIXED[tag]
    elif tag == TAG_F64:
        end = off + 13
    elif tag == TAG_REF:
        end = off + 5
    elif tag in (TAG_STR, TAG_BLOB):
        end = off + 9 + _u32(d, off + 5)
    elif tag == TAG_ARR:
        end = off + 9
    else:
        return -1
    return end if end <= stop else -1


def _fields(d: bytes, start: int, stop: int, limit: int = 400) -> list[tuple[int, int, Any]]:
    """读 [start, stop) 内的字段流 → [(id, tag, 值)]；读不动就停。"""
    out: list[tuple[int, int, Any]] = []
    o, n = start, 0
    while o < stop and n < limit:
        if _elem_class(d, o) is not None:
            break                              # 碰到下一个元素头
        if d[o:o + 4] == b"\x00\x00\x00\x00" and d[o + 4] == 0x00:
            o += 4                             # 空槽 / 列表分隔（4 字节全 0）
            continue
        end = _field_end(d, o, stop)
        if end < 0:
            break
        ident, tag = _u32(d, o), d[o + 4]
        if tag == TAG_F64:
            val: Any = _f64(d, o + 5)
        elif tag in (TAG_STR, TAG_BLOB):
            val = d[o + 9:end]
        elif tag in (TAG_REF, TAG_ARR):
            val = None
        elif FIXED.get(tag) == 1:
            val = d[o + 5]
        elif FIXED.get(tag) == 2:
            val = struct.unpack_from(">H", d, o + 5)[0]
        else:
            val = _u32(d, o + 5)
        out.append((ident, tag, val))
        o, n = end, n + 1
    return out


def _scan_elements(d: bytes, start: int) -> list[tuple[int, int]]:
    """把所有元素捞出来 → [(偏移, class)]，按偏移升序。

    两类锚点：
      - 位置字段 0x2af 在元素头 +15（片段 / 音符 / 音频样本 / 端点标记都有位置）
      - lane 元素（音符轨 / 音频轨）用字段号 0x18cb + tag 0x12 认，它们没有位置字段
    """
    found: set[tuple[int, int]] = set()
    i = start
    while True:
        i = d.find(POS_ID, i)
        if i < 0:
            break
        h = i - HDR
        if h >= start:
            cls = _elem_class(d, h)
            if cls is not None:
                found.add((h, cls))
        i += 1
    i = start
    while True:
        i = d.find(LANE_ID, i)
        if i < 0:
            break
        h = i - 6                              # 元素头在字段号前 6 字节（6B 头标记）
        if h >= start:
            cls = _elem_class(d, h)
            if cls is not None:
                found.add((h, cls))
        i += 1
    return sorted(found)


def _find_all(d: bytes, pat: bytes, start: int = 0) -> list[int]:
    """所有 pattern 出现的位置。"""
    out: list[int] = []
    i = d.find(pat, start)
    while i >= 0:
        out.append(i)
        i = d.find(pat, i + 1)
    return out


def _scan_clips(d: bytes, start: int) -> tuple[list[int], list[tuple[int, str, int]]]:
    """走带片段清单 → ([(片段字段区起点, "midi"/"audio", 轨道槽下标)], 轨道槽偏移表)。

    轨道归属靠"排在片段前面的最近一个片段列表头"（每个轨道一个，顺序与摘要一致），
    不需要名字匹配。复制粘贴出来的副本各自是独立片段对象，都会在这里被捞到。
    """
    slots = _find_all(d, TRACK_SLOT_ID, start)
    out: list[tuple[int, str, int]] = []
    for owner, kind in ((CLIP_OWNER_MIDI, "midi"), (CLIP_OWNER_AUDIO, "audio")):
        for i in _find_all(d, CLIP_OWNER_ID + struct.pack(">I", owner), start):
            h = i - CLIP_PROLOGUE
            if not (h >= start and d[h:h + 5] == POS_ID):
                h = next((k for k in range(max(start, i - 96), i)
                          if d[k:k + 5] == POS_ID), -1)
                if h < 0:
                    continue
            out.append((h, kind, bisect.bisect_right(slots, i) - 1))
    out.sort()
    return slots, out


def _clip_head(d: bytes, h: int, stop: int) -> tuple[float, float]:
    """片段字段区的头两个 f64 = 位置 / 时长（单位：拍）。"""
    start = length = 0.0
    got = 0
    for ident, tag, val in _fields(d, h, min(stop, h + 96), 6):
        if tag != TAG_F64:
            continue
        if ident == F_POS and got == 0:
            start = float(val)
            got = 1
        elif ident == F_LEN and got == 1:
            length = float(val)
            break
    return start, length


def _lane_footers(d: bytes, start: int, stop: int) -> list[tuple[int, int]]:
    """音高轨的 footer 表：[(footer 偏移, MIDI 音高), ...]。

    音高**不在音符上**：音符记录只有位置/时长/力度，同一条"音高轨"里的音符除了
    位置全字节相同。音高写在 lane footer 里 —— 字段 (0xee, tag 0x01) 后面跟一个
    字节的原始 MIDI 音高；音高轨按音高**降序**排在文件里，footer 落在**它那条轨的
    音符之后**。所以某个音符的音高 = 排在它后面的第一个 footer。
    """
    out: list[tuple[int, int]] = []
    i = d.find(PITCH_FOOTER, start, stop)
    while i >= 0:
        out.append((i, d[i + 5]))
        i = d.find(PITCH_FOOTER, i + 1, stop)
    return out


def _str_field(d: bytes, start: int, stop: int, want: tuple[int, ...]) -> str | None:
    """在 [start, stop) 里找指定字段号的字符串。"""
    for ident, tag, val in _fields(d, start, stop):
        if tag in (TAG_STR, TAG_BLOB) and ident in want and val:
            return _text(val)
    return None


def _u32_str_after(d: bytes, ident: int, start: int) -> str | None:
    """按字节模式找 (ident, tag 0x08, 字符串)，比走字段流稳（开头的流里有零槽/引用）。"""
    pat = struct.pack(">I", ident) + bytes([TAG_STR])
    i = d.find(pat, start)
    if i < 0:
        return None
    ln = _u32(d, i + 5)
    if not (0 < ln < 4096):
        return None
    return _text(d[i + 9:i + 9 + ln])


def _u32_str_in(d: bytes, ident: int, start: int, stop: int) -> str | None:
    """在 [start, stop) 里找第一个 (ident, tag 0x08, 字符串)。"""
    pat = struct.pack(">I", ident) + bytes([TAG_STR])
    i = d.find(pat, start, stop)
    if i < 0:
        return None
    ln = _u32(d, i + 5)
    if not (0 < ln < 4096):
        return None
    return _text(d[i + 9:i + 9 + ln])


def _sample_name(d: bytes, start: int, stop: int) -> str:
    """音频样本记录 (class 0xd4) 里的文件名：字段 0x129f 或 0x512（两条一样）。"""
    for ident in F_AUDIO_NAME:
        nm = _u32_str_in(d, ident, start, stop)
        if nm:
            return nm
    return ""


def _u32_str_before(d: bytes, ident: int, start: int, stop: int) -> str | None:
    """在 [start, stop) 里找**最后**一个 (ident, tag 0x08, 字符串)（片段名写在元素头之前）。"""
    pat = struct.pack(">I", ident) + bytes([TAG_STR])
    i = d.rfind(pat, start, stop)
    if i < 0:
        return None
    ln = _u32(d, i + 5)
    if not (0 < ln < 4096):
        return None
    return _text(d[i + 9:i + 9 + ln])


def _find_bpm(d: bytes, start: int) -> float | None:
    """速度 = TEMPO 对象里的 (0x2c8, f64)。先找名字 "TEMPO"，再找它后面的速度值。"""
    pat = struct.pack(">I", F_TEMPO_NAME) + bytes([TAG_STR]) + struct.pack(">I", 5) + b"TEMPO"
    i = d.find(pat, start)
    lo = i if i >= 0 else start
    j = d.find(struct.pack(">I", F_BPM) + bytes([TAG_F64]), lo)
    if j < 0 or j > lo + 4096:
        return None
    val = _f64(d, j + 5)
    return val if 20.0 <= val <= 400.0 else None


# --------------------------------------------------------------- 主入口

def parse_bwproject(path: str | Path) -> Project:
    path = Path(path)
    d = path.read_bytes()
    meta, doc_start = _parse_meta(d)

    proj = Project(name=path.stem, host="bitwig", host_version="", ppq=PPQ)
    ver = meta.get("application_version_name")
    if ver:
        proj.host_version = _text(ver[1])

    # --- 轨道清单（摘要文档）---
    tracks: list[Track] = []
    raw_cls: list[int] = []                    # 摘要里每条轨道的原始 class（下面归音频片段要用）
    summary = meta.get("structure")
    if summary:
        for cls, name in _parse_summary(summary[1]):
            if cls == ROOT_CLASS:
                continue                       # 工程根对象
            kind = TRACK_KIND.get(cls)
            if kind is None:
                proj.warnings.append(f"未知轨道 class {cls:#x}（{name!r}）按 other 处理")
                kind = "other"
            raw_cls.append(cls)
            tracks.append(Track(id=f"t{len(tracks)}", name=name, kind=kind))
    else:
        proj.warnings.append("meta 里没有 structure 摘要，轨道清单缺失")

    # --- 主文档元素 ---
    els = _scan_elements(d, doc_start)
    if not els:
        proj.warnings.append("主文档里一个元素都没扫到，格式可能变了")
        proj.tracks = tracks
        proj.length_ticks = PPQ * 4
        return proj

    by_class: dict[int, int] = {}
    for _h, cls in els:
        by_class[cls] = by_class.get(cls, 0) + 1
    spans = [(h, cls, els[k + 1][0] if k + 1 < len(els) else min(h + 4096, len(d)))
             for k, (h, cls) in enumerate(els)]

    # 全局字段：工程名 / 速度（都在主文档开头；用字节模式找，比走字段流稳）
    name = _u32_str_after(d, F_PROJECT_NAME, doc_start)
    if name:
        proj.name = name
    bpm = _find_bpm(d, doc_start)
    if bpm is None:
        proj.warnings.append("没读到速度字段（0x2c8），按 120 BPM 兜底")
    proj.bpm = bpm if bpm else 120.0
    proj.tempo_map = normalize_tempo_map([], proj.bpm)
    proj.warnings.append("Bitwig 的速度图没逆向，按首速恒定处理")
    proj.warnings.append("拍号没在工程文件里定位到，按 4/4 处理")

    # 音高轨 footer 表（全局）：音符的音高 = 排在它后面的第一个 footer
    footers = _lane_footers(d, doc_start, len(d))
    footer_offs = [f[0] for f in footers]
    if not footers:
        proj.warnings.append("一个音高轨 footer（0xee）都没找到，所有音符按 C4 兜底")

    # --- 片段：走带上的片段实例（复制粘贴出来的副本也是独立一段）---
    slots, clip_objs = _scan_clips(d, doc_start)
    if not clip_objs:
        proj.warnings.append("主文档里没扫到任何片段（0x288 宿主字段），格式可能变了")
    if len(slots) != len(tracks):
        proj.warnings.append(
            f"片段列表头（{len(slots)}）与摘要轨道数（{len(tracks)}）不一致，片段可能归错轨道")

    audio_tracks = [t for t in tracks if t.kind in ("audio", "midi")]
    clip_seq = 0
    clip_clips: list[Clip] = []
    clip_offs: list[int] = []

    # 音频片段的轨道归属：文档里 MIDI 片段组在前、音频片段组在后，音频组按顺序对应
    # 摘要里那些"能放音频"的混合轨（实测 16 组 / 16 条，逐条对得上：踢鼓组、帽子循环、
    # 8 小节循环……）。数量对不上就退回按片段列表头顺序，并留一条警告。
    audio_owners = [i for i, c in enumerate(raw_cls) if c == HYBRID_CLASS]
    audio_slots = sorted({si for _h, kind, si in clip_objs if kind == "audio"})
    audio_map: dict[int, int] = {}
    if audio_slots and len(audio_slots) == len(audio_owners):
        audio_map = {si: audio_owners[k] for k, si in enumerate(audio_slots)}
    elif audio_slots:
        proj.warnings.append(
            f"音频片段组（{len(audio_slots)}）与混合轨（{len(audio_owners)}）数量对不上，"
            "音频片段按片段列表头顺序归轨")

    for k, (h, kind, si) in enumerate(clip_objs):
        stop = clip_objs[k + 1][0] if k + 1 < len(clip_objs) else min(h + 4096, len(d))
        start, length = _clip_head(d, h, stop)
        # 片段名在片段元素**自己的字段区**里（没起名字的片段就是没有这个字段）。
        # 别去抓元素前 96 字节 —— 那里是宿主对象自己的名字（实测是 "Untitled"），
        # 抓到就会把片段全叫 "Untitled"。
        nm = _str_field(d, h, min(stop, h + 512), (F_NAME,)) or ""
        clip = Clip(id=f"c{clip_seq}", name=nm, kind=kind,
                    start_tick=start * PPQ, length_tick=length * PPQ)
        clip_seq += 1
        clip_clips.append(clip)
        clip_offs.append(h)
        ti = audio_map.get(si, si) if kind == "audio" else si
        if 0 <= ti < len(tracks):
            tracks[ti].clips.append(clip)
        else:
            proj.warnings.append(f"片段 #{clip_seq} 找不到宿主轨道（槽号 {si}）")

    no_vel = 0
    no_pitch = 0
    orphan = 0

    for h, cls, nxt in spans:
        if cls != CLS_NOTE:
            continue
        k = bisect.bisect_right(clip_offs, h) - 1
        if k < 0 or clip_objs[k][1] != "midi":
            orphan += 1                            # 音符不在任何 MIDI 片段区间里
            continue
        start = length = 0.0
        vel = None
        for ident, tag, val in _fields(d, h + HDR, nxt):
            if tag != TAG_F64:
                continue
            if ident == F_POS:
                start = float(val)
            elif ident == F_LEN:
                length = float(val)
            elif ident == F_VEL:
                vel = float(val)
        # 音高：从这个音符记录的锚点（概率字段 0x2dfc）往后数第一个 lane footer
        anchor = d.find(CHANCE_ID, h, min(nxt, h + 240))
        pitch = None
        if footers:
            j = bisect.bisect_left(footer_offs, anchor if anchor > 0 else h)
            if j < len(footers):
                pitch = footers[j][1]
        if pitch is None or not 0 <= pitch <= 127:
            no_pitch += 1
            pitch = 60
        if vel is None:
            no_vel += 1
            v = 100
        else:
            v = max(1, min(127, round(vel * 127)))
        clip_clips[k].notes.append(Note(start_tick=start * PPQ, length_tick=length * PPQ,
                                        pitch=pitch, velocity=v))

    if no_vel:
        proj.warnings.append(f"{no_vel} 个音符没读到力度字段（0xef），按 100 兜底")
    if no_pitch:
        proj.warnings.append(
            f"{no_pitch} 个音符后面没有音高轨 footer（0xee），按 C4 兜底")
    if orphan:
        proj.warnings.append(f"{orphan} 个音符不在任何 MIDI 片段区间里，已跳过")

    # --- 音频片段：片段里紧跟的 0xd4 记录 = 它的样本文件 ---
    # 轨道归属已经按"片段列表头"定好了，这里只把文件名补上去。
    sample_offs = [h for h, c, _n in spans if c == CLS_AUDIO_SAMPLE]
    samples: dict[int, str] = {}
    for k, sh in enumerate(sample_offs):
        stop = sample_offs[k + 1] if k + 1 < len(sample_offs) else min(sh + 8192, len(d))
        samples[sh] = _sample_name(d, sh + HDR, stop)

    audio_i = 0
    last_name: dict[int, str] = {}                 # 每个片段组里"最近一次见到的采样名"
    for k, (h, _kind, si) in enumerate(clip_objs):
        if clip_objs[k][1] != "audio":
            continue
        j = bisect.bisect_right(sample_offs, h)
        fname = (samples.get(sample_offs[j]) if j < len(sample_offs) else "") or ""
        # 采样名只在每组片段的第一段记录里出现，后面的片段记录里没有 —— 顺着往前补
        if fname:
            last_name[si] = fname
        fname = last_name.get(si, "")
        clip = clip_clips[k]
        clip.audio_file = fname or None
        clip.name = fname or "音频"
        audio_i += 1
        if 0 <= si < len(tracks):
            continue
        # 槽位对不上（格式变了）时退回按文件名找轨道
        base = _norm(fname.rsplit("/", 1)[-1].rsplit("\\", 1)[-1])
        for t in audio_tracks:
            if not t.clips or _norm(t.name) == base:
                t.clips.append(clip)
                break
    if audio_i and not audio_tracks:
        proj.warnings.append("工程里有音频片段但摘要里没有音频轨")
    unfilled = [t.name for t in audio_tracks if not t.clips]
    if unfilled:
        proj.warnings.append(
            f"{len(unfilled)} 条音频轨没有片段：" + "、".join(unfilled[:3]))

    # --- 未知元素统计 ---
    known = {CLS_MIDI_CLIP, CLS_LANE, CLS_NOTE, CLS_AUDIO_CLIP, CLS_AUDIO_SAMPLE,
             CLS_AUDIO_LANE, CLS_MARKER_PAIR}
    unknown = {c: n for c, n in by_class.items() if c not in known}
    if unknown:
        proj.warnings.append("未认出的元素 class：" + ", ".join(
            f"{c:#x}×{n}" for c, n in sorted(unknown.items())))

    for t in tracks:
        t.clips.sort(key=lambda c: c.start_tick)
    # 混合轨（摘要里 0x287）按实际内容给准 kind：有 MIDI 片段 → 乐器轨，只有音频 → 音频轨
    for t in tracks:
        ks = {c.kind for c in t.clips}
        if "midi" in ks:
            t.kind = "instrument"
        elif "audio" in ks and t.kind in ("midi", "other"):
            t.kind = "audio"
    end = 0.0
    for t in tracks:
        for c in t.clips:
            end = max(end, c.start_tick + c.length_tick)
    proj.length_ticks = (end if end else PPQ * 4) + PPQ * 4   # 末尾留一小节

    proj.tracks = tracks
    return proj
