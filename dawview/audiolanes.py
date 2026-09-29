"""用户音频轨（AudioLane）—— 工程旁边的可写数据 + 本地媒体库。

**为什么单开一份、不塞进契约 JSON**：契约（docs/01-data-contract.md）描述的是
"DAW 工程长什么样"，方向是后端 -> 前端单向推送，前端从不回写。音频轨反过来：
它是**用户自己导入的素材**（参考混音、人声、对拍用的鼓），位置 / 长度都由用户在
界面上拖，必须能回写。两者生命周期不同（重开工程时契约整份重建，音频轨要留着），
所以分开存、分开传。

**存在哪**：默认 `<工程文件所在目录>/.dawview/`
    .dawview/audio-lanes.json   音频轨数据（本模块管）
    .dawview/media/<名字>        导入的音频文件本体（按内容 sha1 去重）
跟着工程走 —— 整个目录拷到别的机器，音频轨和素材一起过去。写不进去（只读盘 /
网络盘）时不报错，退化成"只在内存里用"（`writable=False`，前端给一句提示）。

**幂等与容错**：读到的 JSON 坏了 / 手改出怪字段都不该让服务起不来，
一律按 `clean_lanes()` 收窄：认得的字段留下并夹到合理范围，坏条目整条丢掉。
"""

from __future__ import annotations

import hashlib
import json
import os
import re
import threading
from pathlib import Path
from typing import Callable, Iterable

# 音频轨数据的版本号（字段语义变了就 +1，前端按它决定要不要迁移）
LANES_VERSION = 1

# 能接收的音频扩展名。浏览器 decodeAudioData 认得的就是这些：
# mp3 / wav / ogg(vorbis,opus) / flac / m4a(aac) / aiff / weba。
AUDIO_EXTS = frozenset({
    ".mp3", ".wav", ".wave", ".ogg", ".oga", ".opus", ".flac",
    ".m4a", ".aac", ".aif", ".aiff", ".weba",
})

# 单条媒体上限（1 GB）：再大就该先转码了 —— 前端要整份解码进内存，太大会卡死
MAX_MEDIA_BYTES = 1024 * 1024 * 1024

# 数据规模闸门：畸形请求别把文件写爆
MAX_LANES = 64
MAX_CLIPS_PER_LANE = 512
MAX_NAME_LEN = 200
MAX_ID_LEN = 64
MAX_SECONDS = 86400.0            # 单段最长 24 小时（比这更长一定是数据坏了）
MIN_LENGTH_SEC = 0.02

_ID_RE = re.compile(r"^[A-Za-z0-9_-]{1,%d}$" % MAX_ID_LEN)
# 媒体文件的相对路径：只认 media/<平铺文件名>，天然挡掉 ../ 与子目录
_MEDIA_RE = re.compile(r"^media/[A-Za-z0-9._-]{1,200}$")
# 落盘用的文件名只留 ASCII 安全字符（中文名会被换成 audio-<hash>）
_SAFE_CHARS = re.compile(r"[^A-Za-z0-9._-]+")


def clamp(value: float, lo: float, hi: float) -> float:
    return lo if value < lo else (hi if value > hi else value)


def safe_media_name(name: str, sha1: str) -> str:
    """给导入的文件起一个落盘名：`<sha1 前 8 位>-<清理过的原名>`。

    前面的哈希保证同名不同内容不会互相覆盖（也是去重的依据）；
    原名里的中文 / 空格 / 括号一律换成 '-'（URL 和文件系统都不用再操心转义）。
    """
    raw = os.path.basename(str(name or "")).strip()
    ext = os.path.splitext(raw)[1].lower()
    if ext not in AUDIO_EXTS:
        ext = ".audio"
    stem = os.path.splitext(raw)[0]
    stem = _SAFE_CHARS.sub("-", stem).strip("-._")
    if not stem:
        stem = "audio"
    stem = stem[:80]
    return f"{sha1[:8]}-{stem}{ext}"


def clean_lanes(raw) -> tuple[list[dict], int]:
    """把任意 JSON 收窄成合法的音频轨列表，返回 (干净的 lanes, 丢掉的条目数)。

    不抛异常：界面拖出来的数据偶尔带 NaN / 字符串数字，丢掉那一小条比整份存不上好。
    数值一律夹进合理范围（tick 非负、秒数非负、长度有下限），
    认不得的字段直接不要 —— 存回去的文件只有契约里写的那几个键。
    """
    dropped = 0
    if not isinstance(raw, list):
        return [], 0 if raw in (None, []) else 1
    lanes: list[dict] = []
    for item in raw:
        if not isinstance(item, dict):
            dropped += 1
            continue
        lane_id = item.get("id")
        if not isinstance(lane_id, str) or not _ID_RE.match(lane_id):
            dropped += 1
            continue
        name = item.get("name")
        name = name.strip()[:MAX_NAME_LEN] if isinstance(name, str) and name.strip() else f"音频 {len(lanes) + 1}"
        clips_out: list[dict] = []
        for clip in (item.get("clips") or [])[:MAX_CLIPS_PER_LANE]:
            if not isinstance(clip, dict):
                dropped += 1
                continue
            clip_id = clip.get("id")
            media = clip.get("file")
            if not isinstance(clip_id, str) or not _ID_RE.match(clip_id):
                dropped += 1
                continue
            if not isinstance(media, str) or not _MEDIA_RE.match(media):
                dropped += 1          # 没有文件路径的片段没有意义（画不出也播不出）
                continue
            start_tick = _num(clip.get("startTick"), 0.0, 2 ** 31, 0.0)
            offset = _num(clip.get("srcOffsetSec"), 0.0, MAX_SECONDS, 0.0)
            length = _num(clip.get("lengthSec"), MIN_LENGTH_SEC, MAX_SECONDS, None)
            if length is None:
                dropped += 1          # 长度必须有：它决定"取源文件多长"
                continue
            src_dur = _num(clip.get("srcDurSec"), 0.0, MAX_SECONDS, None)
            cname = clip.get("name")
            cname = cname.strip()[:MAX_NAME_LEN] if isinstance(cname, str) and cname.strip() else media.rsplit("/", 1)[-1]
            # 裁到源文件之内（srcDur 有值时才夹；没有就只保证非负）
            if src_dur is not None:
                offset = clamp(offset, 0.0, max(0.0, src_dur - MIN_LENGTH_SEC))
                length = clamp(length, MIN_LENGTH_SEC, max(MIN_LENGTH_SEC, src_dur - offset))
            out = {
                "id": clip_id,
                "name": cname,
                "file": media,
                "startTick": int(round(start_tick)),
                "srcOffsetSec": round(offset, 6),
                "lengthSec": round(length, 6),
            }
            if src_dur is not None:
                out["srcDurSec"] = round(src_dur, 6)
            clips_out.append(out)
        lanes.append({
            "id": lane_id,
            "name": name,
            "muted": bool(item.get("muted")),
            "clips": clips_out,
        })
        if len(lanes) >= MAX_LANES:
            break
    return lanes, dropped


def _num(value, lo: float, hi: float, default):
    """把可能是字符串 / bool / NaN 的数字收成有限浮点，夹进 [lo, hi]。"""
    if isinstance(value, bool) or value is None:
        return default
    try:
        f = float(value)
    except (TypeError, ValueError):
        return default
    if f != f or f in (float("inf"), float("-inf")):
        return default
    return clamp(f, lo, hi)


class AudioLaneStore:
    """音频轨数据 + 本地媒体库（进程内一份，落盘一份）。

    线程安全：HTTP 服务是多线程的（ThreadingHTTPServer），上传和保存可能同时来。
    """

    def __init__(self, base_dir: Path | str) -> None:
        self.base_dir = Path(base_dir)
        self.path = self.base_dir / "audio-lanes.json"
        self.media_dir = self.base_dir / "media"
        self._lock = threading.RLock()
        self._lanes: list[dict] = []
        self._loaded = False
        self._writable = True
        self._ensure_dir()

    # ------------------------------------------------------------- 基本属性
    def _ensure_dir(self) -> None:
        try:
            self.base_dir.mkdir(parents=True, exist_ok=True)
        except OSError:
            self._writable = False

    @property
    def writable(self) -> bool:
        return self._writable

    # --------------------------------------------------------------- 读写
    def load(self) -> list[dict]:
        """从盘上读一次（之后以内存那份为准）。读不到 / 坏了都当空。"""
        with self._lock:
            if self._loaded:
                return self._lanes
            self._loaded = True
            try:
                blob = json.loads(self.path.read_text(encoding="utf-8"))
            except (OSError, ValueError):
                return self._lanes
            raw = blob.get("lanes") if isinstance(blob, dict) else blob
            lanes, _ = clean_lanes(raw)
            self._lanes = lanes
            return self._lanes

    def snapshot(self) -> dict:
        """给前端的一份完整状态：数据 + 存放位置 + 能不能写。"""
        with self._lock:
            return {
                "version": LANES_VERSION,
                "lanes": json.loads(json.dumps(self.load())),
                "dir": str(self.base_dir),
                "writable": self._writable,
            }

    def save(self, raw) -> tuple[list[dict], bool]:
        """收下一份 lanes，落盘。返回 (收窄后的 lanes, 有没有真的存上)。

        存不上（只读盘）也把内存那份换掉：本次会话照常可用，只是重启就没。
        """
        lanes, _dropped = clean_lanes(raw)
        with self._lock:
            self._lanes = lanes
            self._loaded = True
            blob = json.dumps({"version": LANES_VERSION, "lanes": lanes},
                              ensure_ascii=False, indent=1)
        saved = False
        try:
            self.base_dir.mkdir(parents=True, exist_ok=True)
            tmp = self.path.with_name(self.path.name + ".tmp")
            tmp.write_text(blob, encoding="utf-8")
            tmp.replace(self.path)        # 原子替换：读端不会看到写了一半的 JSON
            saved = True
            self._writable = True
        except OSError:
            self._writable = False        # 只读盘：内存里留着，前端会提示
        return lanes, saved

    # --------------------------------------------------------------- 媒体库
    def media_path(self, rel: str) -> Path | None:
        """`media/xxx.wav` -> 绝对路径；不合法 / 不存在都返回 None。"""
        if not isinstance(rel, str) or not _MEDIA_RE.match(rel):
            return None
        candidate = (self.media_dir / rel.split("/", 1)[1]).resolve()
        try:
            candidate.relative_to(self.media_dir.resolve())
        except (ValueError, OSError):
            return None                   # 越界（理论上 _MEDIA_RE 已经挡掉了）
        return candidate if candidate.is_file() else None

    def find_media(self, name: str) -> Path | None:
        """按 `media/<名字>` 里的名字找文件（前端 GET /media/<名字> 走这里）。"""
        return self.media_path(f"media/{name}")

    def store_media(self, read_chunks: Callable[[int], Iterable[bytes]], length: int,
                    name: str) -> dict:
        """把上传的字节流写进媒体库，返回一条给前端的描述。

        按内容 sha1 命名 -> 同一个文件重复导入只占一份；临时文件在 media/ 目录内，
        写完再 rename（同盘 rename 是原子的，不会出现半个文件被人读到）。
        """
        if length > MAX_MEDIA_BYTES:
            raise ValueError(f"文件超过 {MAX_MEDIA_BYTES // (1024 * 1024)} MB")
        with self._lock:
            self.media_dir.mkdir(parents=True, exist_ok=True)
            tmp = self.media_dir / f".upload-{os.getpid()}-{threading.get_ident()}.part"
            digest = hashlib.sha1()
            written = 0
            try:
                with open(tmp, "wb") as fh:
                    for chunk in read_chunks(length):
                        if not chunk:
                            break
                        digest.update(chunk)
                        written += len(chunk)
                        fh.write(chunk)
                sha = digest.hexdigest()
                target = self.media_dir / safe_media_name(name, sha)
                dup = False
                if target.exists() and target.stat().st_size == written:
                    dup = True                # 同一个文件（同名同内容）重复导入
                    tmp.unlink()
                else:
                    os.replace(tmp, target)
            except BaseException:
                tmp.unlink(missing_ok=True)   # 传到一半断了：不留垃圾
                raise
            self._writable = True
        return {
            "file": f"media/{target.name}",
            "name": str(name or target.name),
            "bytes": written,
            "sha1": sha,
            "dup": dup,
        }


def audio_dir_for(project: str | Path, override: str | Path | None = None) -> Path:
    """音频轨数据放哪：默认"工程文件旁边的 `.dawview/`"（跟着工程走）。"""
    if override:
        return Path(override)
    return Path(project).resolve().parent / ".dawview"
