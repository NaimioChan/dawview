"""dawview 的本地 HTTP 服务层 —— 纯标准库，不依赖 webui2。

四个职责：

1. 把 `web/` 下的静态文件发给浏览器（只绑 127.0.0.1，局域网看不到）
2. `/project.json` —— 直接从内存返回解析好的契约 JSON（不读盘，不会读到陈旧文件）
3. `/health`       —— 存活探针，返回当前连着的页面数（给外部工具和测试用）
4. `/events`       —— SSE 长连接，用来判断"窗口还在不在"（关窗即退出靠它）

为什么用 SSE 而不是"页面定时打心跳"：后台标签页和 OBS 浏览器源里的
`setInterval` 会被浏览器节流（可以慢到一分钟一次），心跳法会把"还在用"
误判成"窗口关了"而提前退出。SSE 连接不依赖页面定时器，窗口一关 TCP 就断，
服务端立刻知道；连接期间由服务端定时写一行注释保活（也顺便探活）。

另一个好处是缓存头由自己控制：以前用 `python -m http.server` 调试时，
启发式缓存会把改过的 `project.json` 缓存住，这里统一 `no-store`。
"""
from __future__ import annotations

import json
import sys
import threading
import time
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

# 每次响应的缓存头：本地工具没有"缓存"的必要，改了就该看到
NO_STORE = {"Cache-Control": "no-store, must-revalidate", "Pragma": "no-cache"}

# SSE 保活间隔。顺带决定"关窗后多久被发现"：写入失败即视为断开，
# 所以这个值同时也是断开检测的粒度。
PING_EVERY = 1.0


class ClientTracker:
    """数着有几个页面连着（SSE 连接数）。

    `seen` 记"历史上有没有连过"：启动到开窗口之间必然没有客户端，
    不能因为此刻是 0 就判定"窗口关了"。关窗退出只认"连过之后又归零"。
    """

    def __init__(self) -> None:
        self._lock = threading.Lock()
        self._clients = 0
        self._seen = 0

    def add(self) -> int:
        with self._lock:
            self._clients += 1
            self._seen += 1
            return self._clients

    def remove(self) -> int:
        with self._lock:
            self._clients = max(0, self._clients - 1)
            return self._clients

    @property
    def clients(self) -> int:
        with self._lock:
            return self._clients

    @property
    def seen(self) -> int:
        with self._lock:
            return self._seen


def make_handler(payload: dict, web_dir: Path, tracker: ClientTracker, *, quiet: bool = True):
    """造一个请求处理器类（payload 闭包进来，只序列化一次）。"""
    body = json.dumps(payload, ensure_ascii=False).encode("utf-8")

    class Handler(SimpleHTTPRequestHandler):
        protocol_version = "HTTP/1.1"          # SSE 需要长连接

        def __init__(self, *args, **kwargs):
            super().__init__(*args, directory=str(web_dir), **kwargs)

        def log_message(self, fmt, *args):     # 默认每条请求都喷 stderr，太吵
            # 只压掉常规访问日志（log_request 固定用这个格式），异常照旧打出来 ——
            # 否则静态文件出错时既没日志也没痕迹，白排查半天。
            if quiet and fmt == '"%s" %s %s':
                return
            super().log_message(fmt, *args)

        # ------------------------------------------------------------ 工具
        def _send(self, code: int, ctype: str, data: bytes) -> None:
            self.send_response(code)
            self.send_header("Content-Type", ctype)
            self.send_header("Content-Length", str(len(data)))
            for k, v in NO_STORE.items():
                self.send_header(k, v)
            self.end_headers()
            self.wfile.write(data)

        def _json(self, obj) -> None:
            self._send(200, "application/json; charset=utf-8",
                       json.dumps(obj, ensure_ascii=False).encode("utf-8"))

        # ------------------------------------------------------------ 路由
        def do_GET(self) -> None:              # noqa: N802（基类的命名）
            path = self.path.split("?", 1)[0]
            if path in ("/project.json", "/api/project"):
                return self._send(200, "application/json; charset=utf-8", body)
            if path == "/health":
                return self._json({"ok": True, "clients": tracker.clients})
            if path == "/events":
                return self._events()
            if path == "/favicon.ico":
                # 浏览器每次开页面都会来要一次；没有就回 204，别让 404 刷日志
                self.send_response(204)
                self.end_headers()
                return
            if path in ("/", "/index.html"):
                self.path = "/index.html"
            # 其余交给静态文件处理；translate_path 自带 ../ 越界防护
            return super().do_GET()

        def do_HEAD(self) -> None:             # noqa: N802
            if self.path.split("?", 1)[0] in ("/project.json", "/api/project"):
                self.send_response(200)
                self.send_header("Content-Type", "application/json; charset=utf-8")
                self.send_header("Content-Length", str(len(body)))
                self.end_headers()
                return
            return super().do_HEAD()

        # -------------------------------------------------------------- SSE
        def _events(self) -> None:
            self.send_response(200)
            self.send_header("Content-Type", "text/event-stream; charset=utf-8")
            self.send_header("Connection", "keep-alive")
            for k, v in NO_STORE.items():
                self.send_header(k, v)
            self.end_headers()
            n = tracker.add()
            try:
                self.wfile.write(b": connected\n\n")
                while True:
                    time.sleep(PING_EVERY)
                    self.wfile.write(b": ping\n\n")   # 写失败 = 对端没了
            except (BrokenPipeError, ConnectionResetError, OSError):
                pass
            finally:
                tracker.remove()
                self.close_connection = True

    return Handler


class _HttpServer(ThreadingHTTPServer):
    """只绑回环地址的 HTTP 服务。

    `allow_reuse_address` 在 Windows 上必须关掉：Windows 的 SO_REUSEADDR 语义是
    "允许抢一个已经被别的进程绑着的端口"，开着的话第二个 dawview 会悄悄绑到同一个
    端口上，而 app.py 里"端口被占 → 提示 + 换端口"那条路永远不会触发。
    Linux/macOS 保留 True，避免重启时撞上 TIME_WAIT。
    """

    allow_reuse_address = sys.platform != "win32"
    daemon_threads = True                  # SSE 线程阻塞着也不挡进程退出


class LocalServer:
    """把 LocalServer.start() 之后就有个能用的 http://127.0.0.1:port/。

    port=0 表示让系统挑一个空闲端口（测试用；被占用时 app.py 也会退到这条）。
    """

    def __init__(self, payload: dict, web_dir: Path, port: int = 8973,
                 *, quiet: bool = True) -> None:
        self.tracker = ClientTracker()
        handler = make_handler(payload, Path(web_dir), self.tracker, quiet=quiet)
        self.httpd = _HttpServer(("127.0.0.1", port), handler)
        self.port = self.httpd.server_address[1]
        self._thread: threading.Thread | None = None

    # ------------------------------------------------------------- 生命周期
    @property
    def url(self) -> str:
        # 用 localhost 而不是 127.0.0.1：两者在浏览器眼里是**不同的源**，而
        # localStorage（主题 / 配色 / 缩放）是按源隔离的。早期版本 webui2 打印的就是
        # http://localhost:<port>，保持一致，用户之前调过的设置才读得回来。
        return f"http://localhost:{self.port}/index.html"

    def start(self) -> "LocalServer":
        self._thread = threading.Thread(target=self.httpd.serve_forever,
                                        name="dawview-http", daemon=True)
        self._thread.start()
        return self

    def stop(self) -> None:
        self.httpd.shutdown()
        self.httpd.server_close()

    # ----------------------------------------------------------------- 判定
    @property
    def clients(self) -> int:
        return self.tracker.clients

    def wait_for_client(self, timeout: float | None = 20.0, step: float = 0.05) -> bool:
        """等第一个页面连上来（前端 boot 时会开 SSE）。

        timeout=None 表示一直等（Ctrl+C 由调用方接）。
        """
        deadline = None if timeout is None else time.monotonic() + timeout
        while True:
            if self.tracker.seen:
                return True
            if deadline is not None and time.monotonic() >= deadline:
                return False
            time.sleep(step)

    def wait_all_closed(self, grace: float = 1.5, step: float = 0.05) -> bool:
        """等"连过之后又归零"并稳定 grace 秒 —— 即窗口被关掉了。

        grace 是为了扛住刷新：页面重载时连接会断一下再回来。
        返回 True 表示确实关干净了；False 表示压根没有客户端来过（调用方自己决定怎么办）。
        """
        if not self.tracker.seen:
            return False
        idle_since: float | None = None
        while True:
            if self.tracker.clients == 0:
                if idle_since is None:
                    idle_since = time.monotonic()
                elif time.monotonic() - idle_since >= grace:
                    return True
            else:
                idle_since = None
            time.sleep(step)

    def serve_forever(self) -> None:
        """常驻（--keep-open / --no-window）：Ctrl+C 才结束。"""
        try:
            while True:
                time.sleep(0.5)
        except KeyboardInterrupt:
            pass
