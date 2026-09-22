"""dawview — 把 DAW 工程文件解析成可滚动浏览的走带视图。

入口：
    python -m dawview <工程文件.cpr>

后端职责：解析工程 -> 契约字典（docs/01-data-contract.md）-> 通过 webui 桥
推给前端；同时把同一份 JSON 写进 web/project.json，作为前端回退数据源
（也便于无头浏览器里验证渲染）。
"""
from __future__ import annotations

import argparse
import json
import os
import subprocess
import sys
import threading
import traceback
from pathlib import Path

# 固定服务端口：见 open_window() 里的说明（localStorage 按端口隔离）
DEFAULT_PORT = 8973

from .cpr_parser import parse_cpr
from .flp_parser import parse_flp

WEB_DIR = Path(__file__).resolve().parent.parent / "web"

# 宿主解析器注册表 —— 后续扩展 bwproject 时在此登记即可
PARSERS = {
    ".cpr": parse_cpr,
    ".flp": parse_flp,
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


def run(path: str | Path, *, width: int = 1280, height: int = 800,
        dev: bool = False) -> int:
    """解析工程并打开 webui 窗口。dev=True 时只写快照不起窗口。"""
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

    if dev:
        print(f"[dawview] 快照已写入 {WEB_DIR / 'project.json'}（dev 模式，未开窗口）")
        return 0

    try:
        from webui import webui as webui_mod
    except ImportError:
        print("[dawview] 未安装 webui2，无法打开窗口。\n"
              "          pip install webui2  （或加 --dev 只看解析结果）",
              file=sys.stderr)
        return 1

    # 本机实测：webui2 的 show()/show_browser() 起不来窗口也起不来服务
    # （browser_exist(Edge) 直接抛访问违规，show() 返回 False 后连 HTTP 服务
    #  都跟着关掉，用户只会看到一个空白窗口）。改用 start_server()：
    # 它只起服务并返回 URL，窗口由我们自己用浏览器 app 模式拉起。
    webui_mod.set_config(webui_mod.Config.use_cookies, False)
    webui_mod.set_config(webui_mod.Config.multi_client, True)

    window = webui_mod.Window()
    window.set_root_folder(str(WEB_DIR))

    # 固定端口：webui 默认每次随机挑一个空闲端口，而浏览器的 localStorage 是按
    # "源"（协议 + 主机 + 端口）隔离的 —— 端口一变，用户调过的主题 / 动效 / 缩放
    # 就全读不回来（实测三次启动分别是 25910 / 25926 / 25939）。钉住端口，
    # 设置才真的"下次打开还能用"。被占用时退回随机端口并明确提示。
    port = DEFAULT_PORT
    env_port = os.environ.get("DAWVIEW_PORT")
    if env_port and env_port.isdigit():
        port = int(env_port)
    try:
        window.set_port(port)
    except Exception as exc:                     # 老版本 webui2 没有 set_port
        print(f"[dawview] 这个 webui2 不支持固定端口（{exc}），设置不会被记住。")

    def load_project(event) -> None:
        """前端 loadProject() 的后端入口（契约 v0.1，单向推送）。

        注意：webui2 的响应必须用 event.return_string() 送回，
        Python 函数的 return 值不会被送到前端（实测返回空字符串）。
        """
        event.return_string(json.dumps(payload, ensure_ascii=False))

    ready = threading.Event()
    closed = threading.Event()
    clients = 0          # multi_client=True 下可能同时有多个页面连着
    lock = threading.Lock()

    def client_ready(event) -> None:
        """前端 boot 成功后回调 —— 用它判断窗口是否真的连上了。"""
        ready.set()
        event.return_string("ok")

    def on_event(event) -> None:
        """空字符串绑定 = 所有事件。

        只有最后一个客户端断开（关掉窗口）才退出：开着 multi_client 时，
        别的浏览器/自动化探针连一下再断开，不能把主程序带走。
        """
        nonlocal clients
        kind = getattr(event, "event_type", None)
        with lock:
            if kind == webui_mod.EventType.CONNECTED:
                clients += 1
            elif kind == webui_mod.EventType.DISCONNECTED:
                clients -= 1
                if clients <= 0:
                    closed.set()

    window.bind("loadProject", load_project)
    window.bind("clientReady", client_ready)
    window.bind("", on_event)

    base = window.start_server("index.html").rstrip("/")
    url = f"{base}/index.html"
    if f":{port}" not in base:
        print(f"[dawview] 端口 {port} 没抢到（实际 {base}）—— 这次启动的设置不会记住；"
              "关掉占用该端口的程序再启动即可。")
    print(f"[dawview] 服务已启动：{url}")

    if _open_app_window(url, width, height) is None:
        print("[dawview] 没找到浏览器，用系统默认浏览器打开")
        webui_mod.open_url(url)

    if not ready.wait(20):
        print(f"[dawview] 窗口已开但前端未握手，请手动检查：{url}")
        return 1

    print("[dawview] 窗口已连接，关掉窗口即退出")
    # 不能直接 webui.wait()：超时后它会返回并让进程退出，服务器随之消失。
    # 等前端断开（关窗）再退出。
    closed.wait()
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
        description="把 Cubase .cpr 工程解析成可滚动浏览的走带视图")
    ap.add_argument("project", help="工程文件路径，例如 26.9.6 lulabi.cpr")
    ap.add_argument("--width", type=int, default=1280)
    ap.add_argument("--height", type=int, default=800)
    ap.add_argument("--dev", action="store_true",
                    help="只解析并写出 web/project.json，不打开窗口")
    args = ap.parse_args(argv)
    return run(args.project, width=args.width, height=args.height, dev=args.dev)


if __name__ == "__main__":
    raise SystemExit(main())
