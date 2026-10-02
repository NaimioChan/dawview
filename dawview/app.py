"""dawview — 把 DAW 工程文件解析成可滚动浏览的走带视图。

入口：
    python -m dawview <工程文件.cpr|flp|rpp|bwproject|song|mid>

后端职责：解析工程 -> 契约字典（docs/01-data-contract.md）-> 起一个本地 HTTP
服务（dawview/server.py，纯标准库）把 web/ 和这份 JSON 发给浏览器；同时把同一份
JSON 写进 web/project.json，这样不跑后端、直接开页面也能看（也便于无头验证）。

窗口用的是系统自带的 Edge/Chrome 的 app 模式（无地址栏），所以除了 Python
本身没有别的依赖要装。
"""
from __future__ import annotations

import argparse
import json
import os
import subprocess
import sys
import traceback
import webbrowser
from pathlib import Path

# 固定服务端口：见 run() 里的说明（localStorage 按端口隔离）
DEFAULT_PORT = 8973

from .audiolanes import AUDIO_EXTS, audio_dir_for
from .bwproject_parser import parse_bwproject
from .cpr_parser import parse_cpr
from .flp_parser import parse_flp
from .midi_parser import parse_midi
from .rpp_parser import parse_rpp
from .song_parser import parse_song

WEB_DIR = Path(__file__).resolve().parent.parent / "web"

# 宿主解析器注册表 —— 加新宿主解析器时在此登记即可
PARSERS = {
    ".bwproject": parse_bwproject,
    ".cpr": parse_cpr,
    ".flp": parse_flp,
    ".mid": parse_midi,
    ".midi": parse_midi,
    ".rpp": parse_rpp,
    ".song": parse_song,
}


def parse_any(path: str | Path) -> dict:
    """按扩展名选择宿主解析器，返回契约字典。

    也接受 `.json`：已经是契约 JSON 就直接拿来用（内置示例快照走这条路，
    不用真工程也能把界面跑起来）。
    """
    path = Path(path)
    if not path.exists():
        raise FileNotFoundError(f"工程文件不存在: {path}")
    if path.suffix.lower() == ".json":
        payload = json.loads(path.read_text(encoding="utf-8"))
        if not isinstance(payload, dict) or "tracks" not in payload:
            raise ValueError(f"{path.name} 不是 dawview 契约 JSON（缺 tracks 字段）")
        return payload
    parser = PARSERS.get(path.suffix.lower())
    if parser is None:
        known = ", ".join(sorted(PARSERS))
        raise ValueError(f"暂不支持 {path.suffix} 格式（当前支持: {known}；也支持直接打开契约 JSON）")
    return parser(path).to_dict()


def write_snapshot(payload: dict, web_dir: Path = WEB_DIR) -> Path:
    """把契约 JSON 落到 web/project.json，作为前端回退数据源。"""
    out = Path(web_dir) / "project.json"
    out.parent.mkdir(parents=True, exist_ok=True)
    out.write_text(json.dumps(payload, ensure_ascii=False), encoding="utf-8")
    return out


def prefs_target(prefs: str | None) -> Path | None:
    """外观设置落盘到哪儿：默认 web/prefs.json；传 none/off 就只在内存里同步。

    单独开这个口子是为了验证（用临时文件，不碰用户那份设置）和便携安装
    （整个目录拷走时把设置放在数据目录里）。
    """
    if prefs is None:
        return WEB_DIR / "prefs.json"
    if prefs.strip().lower() in ("", "none", "off", "-"):
        return None
    return Path(prefs)


def run(path: str | Path, *, width: int = 1280, height: int = 800,
        dev: bool = False, port: int | None = None,
        keep_open: bool = False, no_window: bool = False,
        prefs: str | None = None, audio_dir: str | None = None) -> int:
    """解析工程并起本地服务 + 打开窗口。dev=True 时只写快照，不起服务。"""
    try:
        payload = parse_any(path)
    except Exception as exc:  # 解析失败也要让用户看到原因
        traceback.print_exc()
        print(f"[dawview] 解析失败: {exc}", file=sys.stderr)
        return 1

    write_snapshot(payload)
    meta = payload["meta"]
    n_tracks = len(payload["tracks"])
    n_clips = sum(len(t["clips"]) for t in payload["tracks"])
    n_notes = sum(len(c["notes"]) for t in payload["tracks"] for c in t["clips"])
    print(f"[dawview] {meta['projectName']} | {meta['host']} {meta['hostVersion']} "
          f"| {meta['bpm']} BPM {meta['timeSig'][0]}/{meta['timeSig'][1]} "
          f"| 轨道 {n_tracks} 片段 {n_clips} 音符 {n_notes}")

    # 用户音频轨存哪：默认工程文件旁边的 .dawview/（跟着工程走）
    store_dir = audio_dir_for(path, audio_dir)
    if dev:
        print(f"[dawview] 快照已写入 {WEB_DIR / 'project.json'}（dev 模式，未起服务）")
        return 0

    from .server import LocalServer

    # 固定端口：浏览器的 localStorage 是按"源"（协议 + 主机 + 端口）隔离的，
    # 端口一变，用户调过的主题 / 配色 / 缩放就全读不回来。OBS 的浏览器源也认这个地址。
    want = port if port is not None else DEFAULT_PORT
    if port is None:
        env_port = os.environ.get("DAWVIEW_PORT")
        if env_port and env_port.isdigit():
            want = int(env_port)

    try:
        server = LocalServer(payload, WEB_DIR, port=want,
                             prefs_path=prefs_target(prefs), audio_dir=store_dir)
    except OSError as exc:
        print(f"[dawview] 端口 {want} 用不了（{exc.strerror or exc}），换随机端口。\n"
              "          注意：换端口后浏览器里的设置（主题 / 配色 / 缩放）读不回来，"
              "OBS 浏览器源也要改成下面这个新地址。", file=sys.stderr)
        server = LocalServer(payload, WEB_DIR, port=0,
                             prefs_path=prefs_target(prefs), audio_dir=store_dir)
    server.start()
    url = server.url
    # flush：stdout 走管道时是块缓冲的，别人（脚本 / OBS 的启动器）要立刻看到地址
    print(f"[dawview] 服务已启动：{url}", flush=True)
    print(f"[dawview] OBS 浏览器源填这个地址（外观 / 操作都跟着 app 窗口走）：{url}", flush=True)
    print(f"[dawview] 音频轨（自己导入的音频）存在：{store_dir}")
    if server.audio is not None and not server.audio.writable:
        print("[dawview] 这个目录写不进去：音频轨只在本窗口里有效，关掉就没了",
              file=sys.stderr)

    # 窗口开带 ?role=host 的地址：它是"主窗口"，设置以它为准，并把自己那份推给服务端
    if no_window:
        print("[dawview] --no-window：没开窗口。浏览器或 OBS 浏览器源指向上面这个地址即可。")
    elif _open_app_window(server.host_url, width, height) is None:
        print("[dawview] 没找到 Edge/Chrome，用系统默认浏览器打开（会有地址栏）")
        webbrowser.open(server.host_url)

    # 第一个页面连上来之前不能判定"窗口关了"，所以这里等（最多 20 秒只是提示）。
    if not server.wait_for_client(20):
        print("[dawview] 20 秒内没有页面连上来，服务继续跑着：")
        print(f"          {url}")
        print("          （用 OBS 浏览器源时就指这个地址；Ctrl+C 结束）")
        try:
            server.wait_for_client(None)          # 等到第一个页面来
        except KeyboardInterrupt:
            print("\n[dawview] 收到中断，退出")
            return 0

    print("[dawview] 页面已连上")
    if keep_open:
        print("[dawview] --keep-open：页面关掉也不退出，Ctrl+C 结束")
        server.serve_forever()
        return 0
    print("[dawview] 关掉页面即退出（想让它常驻就加 --keep-open）")
    server.wait_all_closed()
    return 0


def _find_browser_exe() -> str | None:
    """定位 Chromium 系浏览器可执行文件（Edge 优先）。"""
    folder = _find_browser_folder()
    if not folder:
        return None
    for name in ("msedge.exe", "chrome.exe"):
        exe = Path(folder) / name
        if exe.exists():
            return str(exe)
    return None


def _open_app_window(url: str, width: int, height: int):
    """用浏览器 app 模式开一个无地址栏窗口，独立 profile。返回 Popen 或 None。"""
    exe = _find_browser_exe()
    if not exe:
        return None
    profile = Path(os.environ.get("LOCALAPPDATA", Path.home())) / "dawview" / "browser-profile"
    profile.mkdir(parents=True, exist_ok=True)
    return subprocess.Popen([
        exe,
        f"--app={url}",
        f"--window-size={width},{height}",
        f"--user-data-dir={profile}",
        "--no-first-run",
        "--no-default-browser-check",
    ])


def _find_browser_folder() -> str | None:
    """定位 Chromium 系浏览器目录（Edge 优先）。"""
    candidates = [
        r"C:\Program Files (x86)\Microsoft\Edge\Application",
        r"C:\Program Files\Microsoft\Edge\Application",
        r"C:\Program Files\Google\Chrome\Application",
        r"C:\Program Files (x86)\Google\Chrome\Application",
    ]
    local = Path.home() / "AppData" / "Local"
    candidates += [
        str(local / "Microsoft" / "Edge" / "Application"),
        str(local / "Google" / "Chrome" / "Application"),
    ]
    for c in candidates:
        p = Path(c)
        if (p / "msedge.exe").exists() or (p / "chrome.exe").exists():
            return str(p)
    return None


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(
        prog="dawview",
        description="把 Cubase .cpr / FL Studio .flp / REAPER .rpp / Bitwig .bwproject / Studio One .song / MIDI .mid 文件解析成可滚动浏览的走带视图"
                    "（还能自己拖音频进来对拍：" + " ".join(sorted(AUDIO_EXTS)) + "）")
    ap.add_argument("project", help="工程文件路径，例如 26.9.6 lulabi.cpr")
    ap.add_argument("--width", type=int, default=1280)
    ap.add_argument("--height", type=int, default=800)
    ap.add_argument("--dev", action="store_true",
                    help="只解析并写出 web/project.json，不起服务也不开窗口")
    ap.add_argument("--port", type=int, default=None,
                    help=f"本地服务端口（默认 {DEFAULT_PORT}；也可用环境变量 DAWVIEW_PORT）")
    ap.add_argument("--no-window", action="store_true",
                    help="不起窗口，只起服务（给 OBS 浏览器源 / 外部浏览器用）")
    ap.add_argument("--keep-open", action="store_true",
                    help="页面关掉后服务继续跑，Ctrl+C 才退出")
    ap.add_argument("--prefs", default=None, metavar="PATH",
                    help="外观设置（主题 / 显示选项 / 轨道配色）的落盘位置，"
                         "默认 web/prefs.json；传 none 就只在内存里同步")
    ap.add_argument("--audio-dir", default=None, metavar="PATH",
                    help="用户音频轨（自己导入的音频 + 数据）存哪儿，"
                         "默认工程文件旁边的 .dawview/")
    args = ap.parse_args(argv)
    try:
        return run(args.project, width=args.width, height=args.height, dev=args.dev,
                   port=args.port, keep_open=args.keep_open, no_window=args.no_window,
                   prefs=args.prefs, audio_dir=args.audio_dir)
    except KeyboardInterrupt:
        print("\n[dawview] 收到中断，退出")
        return 0


if __name__ == "__main__":
    raise SystemExit(main())
