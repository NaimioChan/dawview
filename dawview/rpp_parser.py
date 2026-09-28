"""REAPER .rpp parser（实证逆向，实测工程 REAPER 7.67/win64）。

RPP 是**纯文本分块**格式（不像 .cpr / .flp 是二进制）：

    <TAG 参数...        开块
      KEY 参数...       块里的定值行
    >                   关块

行尾 CRLF；字符串只在需要时加引号（`NAME "Drum Bus"` / `NAME Snare`），
块与定值行的首尾空白都无意义。

## 单位与语义（社区 state-chunk 文档 + 本工程实测交叉验证）

- **片段位置是秒**：`<ITEM>` 的 `POSITION` / `LENGTH` / `SOFFS` 都用秒。
  实测判据（不靠文档也立得住）：一个 `LENGTH 20.21052631578947` 的片段在
  190 BPM 下正好是 64 个四分音符，而同一片段里 MIDI 事件的 tick 偏移逐条
  累加正好等于 61440 = 64 × 960 —— 两条独立数据流对上同一个数。
- **MIDI 事件**：`E <相对上一条的 tick 偏移> <状态字节 d1 d2>`，
  行首字母 `e` = 选中 / `E` = 未选中，**两者都是事件**（实测同一源里
  69 条 `E` + 68 条 `e`，漏掉一半音符就少一半），大小写都收。
  状态字节与数据字节是**十六进制**（`E 0 90 28 60` = note-on，音高 0x28 = 40，
  力度 0x60 = 96），只有偏移是十进制。偏移是**增量**：同一条流里出现
  0 / 960 / 0 / 960 …，绝对值语义会倒退，说不通。
  ppq 从 `<SOURCE MIDI>` 的 `HASDATA 1 960 QN` 取（REAPER 固定 960；
  万一不是 960，按比例缩放到契约的 ppq）。
  状态字节：0x9n = note-on（力度 0 当 note-off 用）、0x8n = note-off、
  0xBn = CC（d1 = 号 / d2 = 值）。
  REAPER 会在每个 MIDI 源末尾写一条 CC123（全部音符关），这里照收（不筛）。
- **速度**：工程速度 = 顶层 `TEMPO <bpm> <拍号分子> <拍号分母> ...`；
  速度轨 = `<TEMPOENVEX>` 里的 `PT <秒> <bpm> <形状> ...`（包络点的位置单位
  与其它包络一致，是秒）。REAPER 的速度轨本身就是阶梯（一个点保持到下一个点），
  不用插值 —— 与契约 v0.3 的语义天然一致。
  ⚠ 本工程（dnb.rpp）的 TEMPOENVEX 里没有变速点，所以"多个 PT 点"这一支
  是按 state-chunk 文档写的，还没在真机上对过；换一份带变速的工程即可复核。
- **标记**：顶层 `MARKER <序号> <秒> <名字> <标志位> <颜色> ...`，
  标志位 &1 = 区间、&16 = 隐藏。区间是**两行同序号**的 MARKER（第二行名字为空
  或省略）—— 只取第一行的起点，不拿终点当第二个标记。
- **轨道**：`ISBUS <folder> <缩进>`，folder = 1 是文件夹父轨、2 是文件夹里
  最后一条轨（这行自己还是有内容的普通轨）。`<FXCHAIN>` 里的插件描述前缀带 i
  （`VST3i:` / `VSTi:`）表示乐器，据此把 kind 分成 instrument / midi。
- **工程名不在文件里**，用文件名（REAPER 自己也是这么显示的）。

## 已知取舍

- 一个 item 只取**第一个 take**（第一个 `<SOURCE>` 块）：多 take 的工程会少画别的 take。
- 片段标了 `LOOP 1` 而源内容比片段短时，REAPER 会循环播放源内容；这里**不复制**
  音符（不造数据），只记一条 warning —— MIDI 源没有显式的"源长度"字段，
  循环单位推不出来。
- `PLAYRATE != 1` 的 MIDI 片段：音符按 `1 / playrate` 压缩（视觉上跟片段对齐）。
- `<FREEZE>` 里的原始 item 块是"解冻时恢复用"的副本，不解析（不然音符会翻倍）。
"""
from __future__ import annotations

from pathlib import Path

from .model import CC_NAMES, Clip, Controller, Note, Project, Track, normalize_tempo_map

PROJECT_PPQ = 960             # REAPER 的 MIDI 源固定 960 ticks / 四分音符
DEFAULT_SAMPLE_RATE = 44100.0
BPM_MIN, BPM_MAX = 5.0, 999.0
TAIL_BEATS = 4                # lengthTicks 在最后一段内容后留一小节

MIDI_NOTE_OFF = 0x80
MIDI_NOTE_ON = 0x90
MIDI_CONTROL = 0xB0
MIDI_STATUS_MASK = 0xF0

HIDDEN_MARKER_FLAG = 16
FOLDER_PARENT = 1


# ------------------------------------------------------------------ 分块解析

class _Block:
    """RPP 的一个块（`<TAG 参数>` … `>`）；块里既有定值行也有子块。"""

    __slots__ = ("tag", "args", "lines", "blocks")

    def __init__(self, tag: str, args: list[str]):
        self.tag = tag
        self.args = args
        self.lines: list[tuple[str, list[str]]] = []
        self.blocks: list["_Block"] = []

    # 定值行访问：同一个 KEY 出现多次时取**最后一个**（REAPER 后写的赢）
    def get(self, key: str) -> list[str] | None:
        for k, a in reversed(self.lines):
            if k == key:
                return a
        return None

    def num(self, key: str, index: int = 0, default: float | None = None) -> float | None:
        args = self.get(key)
        if not args or len(args) <= index:
            return default
        try:
            return float(args[index])
        except ValueError:
            return default

    def text(self, key: str) -> str:
        args = self.get(key)
        return args[0] if args else ""

    def child(self, tag: str) -> "_Block | None":
        for b in self.blocks:
            if b.tag == tag:
                return b
        return None

    def children(self, tag: str) -> list["_Block"]:
        return [b for b in self.blocks if b.tag == tag]


def _split_tokens(text: str) -> list[str]:
    """按空白切分，但引号里的空白归同一个词（RPP 只在需要时加引号）。

    反斜杠**不转义**：Windows 路径在 RPP 里是原样的 `FILE "Media\\kick.wav"`。
    所以只有"`\\` 后面是引号、而且这一行后面还有别的引号"时才当转义 ——
    `"C:\\dir\\"` 这种以反斜杠结尾的字符串不会被吃掉结尾引号。
    空字符串（`NAME ""`）也要留下一个空 token：它是"名字是空的"，
    和"没有 NAME 行"是两件事。
    """
    out: list[str] = []
    buf: list[str] = []
    in_quotes = False
    started = False
    i = 0
    n = len(text)
    while i < n:
        c = text[i]
        if in_quotes:
            if c == "\\" and i + 1 < n and text[i + 1] == '"' and '"' in text[i + 2:]:
                buf.append('"')
                i += 2
                continue
            if c == '"':
                in_quotes = False
            else:
                buf.append(c)
        elif c == '"':
            in_quotes = True
            started = True
        elif c.isspace():
            if started or buf:
                out.append("".join(buf))
                buf = []
                started = False
        else:
            buf.append(c)
            started = True
        i += 1
    if started or buf:
        out.append("".join(buf))
    return out


def _parse_blocks(text: str) -> _Block:
    """整份 RPP -> 一棵块树（根节点是文件，真正的工程节点是它的第一个子块）。"""
    root = _Block("", [])
    stack = [root]
    for raw in text.splitlines():
        line = raw.strip()
        if not line:
            continue
        if line[0] == "<":
            tokens = _split_tokens(line[1:])
            block = _Block(tokens[0] if tokens else "", tokens[1:])
            stack[-1].blocks.append(block)
            stack.append(block)
        elif line[0] == ">":
            if len(stack) > 1:
                stack.pop()
        else:
            tokens = _split_tokens(line)
            if tokens:
                stack[-1].lines.append((tokens[0], tokens[1:]))
    return root


def _read_text(path: Path) -> tuple[str, bool]:
    """读成文本。返回 (文本, 解码是否干净) —— REAPER 7 写 UTF-8（带 BOM）。"""
    raw = path.read_bytes()
    try:
        return raw.decode("utf-8-sig"), True
    except UnicodeDecodeError:
        return raw.decode("utf-8-sig", "replace"), False


# ------------------------------------------------------------ 秒 <-> tick 换算

class _Timebase:
    """RPP 只写秒，契约只认 tick —— 这里做双向换算（阶梯速度轨，分段积分/反解）。

    points 是 [[秒, bpm], ...]，按秒升序、首点在 0。段内速度恒定，
    所以 秒→tick 是分段线性积分，tick→秒 是它的反函数。
    """

    def __init__(self, points: list[list[float]], ppq: float):
        self.points = points
        self.ppq = float(ppq)
        self.ticks = [0.0]
        for i in range(1, len(points)):
            dt = points[i][0] - points[i - 1][0]
            self.ticks.append(self.ticks[-1] + dt * points[i - 1][1] / 60.0 * self.ppq)

    def _segment_by_sec(self, sec: float) -> int:
        i = 0
        while i + 1 < len(self.points) and self.points[i + 1][0] <= sec:
            i += 1
        return i

    def sec_to_tick(self, sec: float) -> float:
        if not self.points:                       # 兜底：没有速度点就按 120 算
            return sec * 120.0 / 60.0 * self.ppq
        i = self._segment_by_sec(sec)
        return self.ticks[i] + (sec - self.points[i][0]) * self.points[i][1] / 60.0 * self.ppq

    def tick_to_sec(self, tick: float) -> float:
        i = 0
        while i + 1 < len(self.ticks) and self.ticks[i + 1] <= tick:
            i += 1
        bpm = self.points[i][1]
        return self.points[i][0] + (tick - self.ticks[i]) / (self.ppq * bpm / 60.0)

    def span_sec(self, start_sec: float, end_sec: float) -> float:
        return self.sec_to_tick(end_sec) - self.sec_to_tick(start_sec)


# ------------------------------------------------------------------ 主入口

def parse_rpp(path: str | Path) -> Project:
    path = Path(path)
    text, clean = _read_text(path)
    root = _parse_blocks(text)
    head = root.child("REAPER_PROJECT")
    if head is None:
        raise ValueError(f"{path.name} 不是 REAPER 工程文件（开头没有 <REAPER_PROJECT））")

    project = Project(
        name=path.stem,
        host="reaper",
        # 文件头第 2 个字段是"版本号/平台"（实测 "7.67/win64"）
        host_version=head.args[1] if len(head.args) > 1 else "unknown",
        ppq=PROJECT_PPQ,
        sample_rate=DEFAULT_SAMPLE_RATE,
    )
    if not clean:
        project.warnings.append("工程里有非 UTF-8 字节，名字可能显示成乱码（按 replace 解的）")

    sample_rate = head.num("SAMPLERATE", 0)
    if sample_rate and sample_rate > 0:
        project.sample_rate = float(sample_rate)

    tempo = head.get("TEMPO")
    if tempo and len(tempo) >= 3:
        bpm = _to_float(tempo[0])
        if bpm is not None and BPM_MIN <= bpm <= BPM_MAX:
            project.bpm = bpm
        else:
            project.warnings.append(f"工程速度 {tempo[0]} 不像是 BPM，先按 120 显示")
        num, denom = _to_float(tempo[1]), _to_float(tempo[2])
        if num and denom:
            project.time_sig = (int(num), int(denom))
    else:
        project.warnings.append("工程里没有 TEMPO 行，按 120 BPM 4/4 显示")

    points_sec, tempo_note = _tempo_points(head, project.bpm)
    timebase = _Timebase(points_sec, project.ppq)
    project.tempo_map = normalize_tempo_map(
        [(timebase.sec_to_tick(sec), bpm) for sec, bpm in points_sec], project.bpm)
    project.bpm = project.tempo_map[0][1]
    if tempo_note:
        project.warnings.append(tempo_note)

    project.markers = _markers(head, timebase)

    for tr in head.children("TRACK"):
        track = _make_track(tr, timebase, project)
        track.id = f"t{len(project.tracks)}"
        project.tracks.append(track)

    end = 0.0
    for t in project.tracks:
        for c in t.clips:
            end = max(end, c.start_tick + c.length_tick)
    if end:
        project.length_ticks = end + TAIL_BEATS * project.ppq
    return project


def _to_float(text: str) -> float | None:
    try:
        return float(text)
    except (TypeError, ValueError):
        return None


# ------------------------------------------------------------------ 速度轨

def _tempo_points(head: _Block, project_bpm: float) -> tuple[list[list[float]], str]:
    """`<TEMPOENVEX>` 的 PT 点 -> ([[秒, bpm], ...], 说明文字)。

    没有变速点（工程定速）时返回单点 [[0, 工程速度]] —— REAPER 定速工程的
    TEMPOENVEX 是空的（实测 dnb.rpp）。
    """
    env = head.child("TEMPOENVEX")
    points: list[list[float]] = []
    if env is not None:
        for args in [a for k, a in env.lines if k == "PT"]:
            if len(args) < 2:
                continue
            sec, bpm = _to_float(args[0]), _to_float(args[1])
            if sec is None or bpm is None or not (BPM_MIN <= bpm <= BPM_MAX):
                continue
            points.append([max(0.0, sec), bpm])
    points.sort(key=lambda p: p[0])
    if not points:
        return [[0.0, project_bpm]], ""

    if points[0][0] > 0:
        # 第一个变速点不在 0 —— 前面那段按工程速度走
        points.insert(0, [0.0, project_bpm])
    # 同一时刻重复的点：后写的赢
    dedup: dict[float, float] = {}
    for sec, bpm in points:
        dedup[round(sec, 9)] = bpm
    clean = [[s, dedup[s]] for s in sorted(dedup)]
    return clean, f"速度轨：{len(clean)} 个变速点（阶梯语义）"


# ------------------------------------------------------------------ 标记

def _markers(head: _Block, timebase: _Timebase) -> list[list]:
    """顶层 MARKER 行 -> [[tick, 名字], ...]（升序）。

    区间的第二行（同序号、名字为空）、隐藏的标记（标志位 &16）都跳过。
    """
    out: list[list] = []
    for args in [a for k, a in head.lines if k == "MARKER"]:
        if len(args) < 3:
            continue
        sec, name = _to_float(args[1]), args[2]
        if sec is None or not name:
            continue
        flags = _to_float(args[3]) if len(args) > 3 else 0.0
        if flags and int(flags) & HIDDEN_MARKER_FLAG:
            continue
        out.append([timebase.sec_to_tick(sec), name])
    out.sort(key=lambda m: m[0])
    return out


# ------------------------------------------------------------------ 轨道 / 片段

def _make_track(tr: _Block, timebase: _Timebase, project: Project) -> Track:
    name = tr.text("NAME").strip()
    folder = tr.get("ISBUS")
    folder_state = int(_to_float(folder[0]) or 0) if folder else 0

    clips: list[Clip] = []
    for index, item in enumerate(tr.children("ITEM")):
        try:
            clips.append(_make_clip(item, index, timebase, project, name))
        except Exception as exc:                  # 单片段失败不影响别的
            project.warnings.append(f"轨道「{name or '?'}」第 {index + 1} 个片段解析失败：{exc}")
    clips.sort(key=lambda c: c.start_tick)

    return Track(id="", name=name or f"轨道 {len(project.tracks) + 1}",
                 kind=_track_kind(folder_state, clips, _has_instrument(tr)), clips=clips)


def _track_kind(folder_state: int, clips: list[Clip], instrument: bool) -> str:
    """轨道种类：文件夹 > MIDI（乐器）/ 音频 > 其他。

    REAPER 的轨道是"通用轨"（一条轨上可以既有音频又有 MIDI），所以按
    "这条轨上有哪些片段" + FX 链里有没有乐器来判，判不出来就是 other。
    """
    if folder_state == FOLDER_PARENT:
        return "folder"
    kinds = {c.kind for c in clips}
    if "midi" in kinds:
        return "instrument" if instrument else "midi"
    if "audio" in kinds:
        return "audio"
    return "other"


def _has_instrument(tr: _Block) -> bool:
    """FX 链里有没有乐器：插件描述的前缀（`VST3i:` / `VSTi:`）带 i。"""
    chain = tr.child("FXCHAIN")
    if chain is None:
        return False
    for block in chain.blocks:
        if not block.tag.startswith(("VST", "AU", "CLAP", "JS")):
            continue
        if block.args and block.args[0].split(":", 1)[0].strip().endswith("i"):
            return True
    return False


def _make_clip(item: _Block, index: int, timebase: _Timebase, project: Project,
               track_name: str) -> Clip:
    pos_sec = item.num("POSITION", 0, 0.0) or 0.0
    len_sec = item.num("LENGTH", 0, 0.0) or 0.0
    start_tick = timebase.sec_to_tick(pos_sec)
    length_tick = max(0.0, timebase.sec_to_tick(pos_sec + len_sec) - start_tick)
    name = item.text("NAME").strip()

    source = item.blocks[0] if item.blocks else None
    if source is None:
        return Clip(id=f"c{index}", name=name or track_name or f"片段 {index + 1}",
                    kind="other", start_tick=start_tick, length_tick=length_tick)

    is_midi = source.tag == "SOURCE" and source.args and source.args[0].upper() == "MIDI"
    if is_midi:
        clip = _make_midi_clip(source, item, index, timebase, project, name, track_name,
                               start_tick, length_tick)
        return clip

    audio_file = _source_file(source)
    if audio_file:
        label = name or Path(audio_file.replace("\\", "/")).stem
        return Clip(id=f"c{index}", name=label, kind="audio", start_tick=start_tick,
                    length_tick=length_tick, audio_file=audio_file)

    project.warnings.append(f"认不出的片段源（{source.tag} {' '.join(source.args)}）"
                            f"，按普通色块显示")
    return Clip(id=f"c{index}", name=name or track_name or f"片段 {index + 1}",
                kind="other", start_tick=start_tick, length_tick=length_tick)


def _source_file(source: _Block) -> str:
    """从 `<SOURCE WAVE>` / `<SOURCE SECTION>`（里面再套一层 SOURCE）里取 FILE。"""
    args = source.get("FILE")
    if args and args[0]:
        return args[0]
    for nested in source.blocks:
        if nested.tag.startswith("SOURCE"):
            got = _source_file(nested)
            if got:
                return got
    return ""


def _make_midi_clip(source: _Block, item: _Block, index: int, timebase: _Timebase,
                    project: Project, name: str, track_name: str,
                    start_tick: float, length_tick: float) -> Clip:
    label = name or item.text("NAME").strip() or track_name or f"片段 {index + 1}"
    events, src_ppq = _midi_events(source)
    scale = project.ppq / src_ppq if src_ppq else 1.0

    # 滑移量（SOFFS，秒）和播放速率：片段显示的是源里哪个区间
    soffs_sec = (item.num("SOFFS", 0, 0.0) or 0.0)
    rate = item.num("PLAYRATE", 0, 1.0) or 1.0
    if rate <= 0.001:
        rate = 1.0
    soffs_tick = float(timebase.span_sec(0.0, soffs_sec)) if soffs_sec else 0.0
    if abs(rate - 1.0) > 1e-9:
        project.warnings.append(
            f"片段「{label}」的播放速率是 {rate:.4f}，音符按速率压缩显示")

    ign = source.get("IGNTEMPO")
    if ign and _to_float(ign[0]) == 1.0:
        project.warnings.append(f"片段「{label}」忽略了工程速度（IGNTEMPO），时间轴按工程速度画")

    limit = length_tick if length_tick > 0 else 0.0

    def to_clip_tick(src_tick: float) -> float:
        # 源 tick -> 契约 tick：先按 ppq 缩放，再减滑移量、除以播放速率
        return (src_tick * scale - soffs_tick) / rate

    notes: list[Note] = []
    pending: dict[tuple[int, int], tuple[float, int]] = {}
    controllers: dict[int, list[list[float]]] = {}
    last_tick = 0.0
    for tick, status, d1, d2 in events:
        last_tick = tick
        kind = status & MIDI_STATUS_MASK
        if kind == MIDI_NOTE_ON and d2 > 0:
            pending[(status & 0x0F, d1)] = (tick, d2)
        elif kind in (MIDI_NOTE_ON, MIDI_NOTE_OFF):
            got = pending.pop((status & 0x0F, d1), None)
            if got is None:
                continue
            start_rel = to_clip_tick(got[0])
            end_rel = to_clip_tick(tick)
            if limit:
                end_rel = min(end_rel, limit)
            length = end_rel - start_rel
            if length <= 0 or start_rel >= (limit or float("inf")) or end_rel <= 0:
                continue
            notes.append(Note(start_tick=start_rel, length_tick=length, pitch=int(d1),
                              velocity=max(1, min(127, int(got[1])))))
        elif kind == MIDI_CONTROL:
            controllers.setdefault(int(d1), []).append(
                [to_clip_tick(tick), max(0, min(127, int(d2)))])

    # 没等到 note-off 的音符：按源里最后一个事件收尾（别长到片段外面去）
    for (_ch, pitch), (start_src, velocity) in pending.items():
        start_rel = to_clip_tick(start_src)
        end_rel = to_clip_tick(last_tick)
        if limit:
            end_rel = min(end_rel, limit)
        if end_rel - start_rel > 0:
            notes.append(Note(start_tick=start_rel, length_tick=end_rel - start_rel,
                              pitch=int(pitch), velocity=max(1, min(127, int(velocity)))))

    content_end = max((to_clip_tick(last_tick),), default=0.0)
    loop = item.num("LOOP", 0, 0.0)
    if loop and limit and content_end < limit - 1.0:
        project.warnings.append(
            f"片段「{label}」标了循环播放（LOOP 1）但源内容比片段短，只画了源内容")

    notes.sort(key=lambda n: n.start_tick)
    clip = Clip(id=f"c{index}", name=label, kind="midi", start_tick=start_tick,
                length_tick=length_tick, notes=notes)
    for cc in sorted(controllers):
        points = _dedupe_ticks(controllers[cc])
        clip.controllers.append(Controller(cc=cc, points=points,
                                           name=CC_NAMES.get(cc, f"CC{cc}")))
    return clip


def _dedupe_ticks(points: list[list[float]]) -> list[list[float]]:
    """同一个 tick 上的多个值只留最后一个（阶梯语义下后面的值才有效）。"""
    by_tick: dict[float, float] = {}
    for tick, value in sorted(points, key=lambda p: p[0]):
        by_tick[round(tick, 6)] = value
    return [[tick, by_tick[tick]] for tick in sorted(by_tick)]


def _midi_events(source: _Block) -> tuple[list[tuple[float, int, int, int]], float]:
    """`<SOURCE MIDI>` -> ([(绝对 tick, 状态字节, d1, d2), ...], 源 ppq)。

    偏移是**增量**（十进制），状态/数据字节是十六进制。
    """
    src_ppq = PROJECT_PPQ
    hasdata = source.get("HASDATA")
    if hasdata and len(hasdata) >= 2:
        got = _to_float(hasdata[1])
        if got:
            src_ppq = got

    events: list[tuple[float, int, int, int]] = []
    tick = 0.0
    for key, args in source.lines:
        if key.lower() != "e" or len(args) < 3:
            continue
        delta = _to_float(args[0])
        if delta is None:
            continue
        try:
            status = int(args[1], 16)
            d1 = int(args[2], 16)
            d2 = int(args[3], 16) if len(args) > 3 else 0
        except ValueError:
            continue
        tick += delta
        events.append((tick, status, d1, d2))
    return events, src_ppq
