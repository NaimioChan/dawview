"""dawview 的本地 HTTP 服务层 —— 纯标准库，不依赖 webui2。

六个职责：

1. 把 `web/` 下的静态文件发给浏览器（只绑 127.0.0.1，局域网看不到）
2. `/project.json` —— 直接从内存返回解析好的契约 JSON（不读盘，不会读到陈旧文件）
3. `/health`       —— 存活探针，返回当前连着的页面数（给外部工具和测试用）
4. `/events`       —— SSE 长连接。两件事：判断"窗口还在不在"（关窗即退出靠它），
                      以及把事件推给页面（设置同步 / 控制中继，即下面两条）
5. `/prefs`        —— 页面外观设置的共享副本（主题 / 显示选项 / 轨道配色）。
                      OBS 浏览器源和 app 窗口不是同一个浏览器实例，localStorage
                      按实例隔离，所以只能靠服务端这份中转。
6. `/control`      —— 控制中继：一个窗口里的操作（播放 / 定位 / 缩放 / 视图切换…）
                      广播给其它窗口执行，于是"在 app 窗口里操作，OBS 画面跟着走"，
                      OBS 那边不用开 Interact 抢焦点。

为什么用 SSE 而不是"页面定时打心跳"：后台标签页和 OBS 浏览器源里的
`setInterval` 会被浏览器节流（可以慢到一分钟一次），心跳法会把"还在用"
误判成"窗口关了"而提前退出。SSE 连接不依赖页面定时器，窗口一关 TCP 就断，
服务端立刻知道；连接期间由服务端定时写一行注释保活（也顺便探活）。

另一个好处是缓存头由自己控制：以前用 `python -m http.server` 调试时，
启发式缓存会把改过的 `project.json` 缓存住，这里统一 `no-store`。
"""
from __future__ import annotations

import json
import queue
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

# POST 请求体上限：/prefs 与 /control 都是小对象，给个闸门免得畸形请求吃内存
MAX_POST_BYTES = 256 * 1024

# 单个页面的事件积压上限：对端读得慢就丢事件（这些都是"当前状态"类消息，
# 丢一条不丢状态 —— 下一条会覆盖它），绝不反过来卡住发信方。
CLIENT_QUEUE = 64

# /control 允许的动作白名单 —— 必须和前端 web/app.js 里 CONTROL_ACTIONS 的键一致。
# 白名单是刻意的：中继会把动作广播给所有窗口**执行**，不能让任意字符串过去。
CONTROL_ACTIONS = frozenset({
    "play", "pause", "toggleplay", "home",                # 走带
    "seek",                                               # {tick} 定位
    "tick",                                               # {tick} 播放中的位置校准
    "zoom",                                               # {factor}
    "zoomto",                                             # {pxPerTick, anchorTick, anchorFrac}
    "fit",                                                # 适应窗口（各自按自己的宽度算）
    "setrowh", "setsemih", "setlaneh",                    # {value} 行高
    "setviewmode",                                        # {mode: 'arrange'|'midi'}
    "setclean", "setexport", "setheads", "setclipnames",   # {on}
    "setfollow",                                          # {mode: 'page'|'center'}
    "setspeed", "setfx", "setlanes",                      # 速度 / 动效 / 控制器栏
    "track", "trackall", "sethidden",                     # 轨道显示隐藏
})


class _BadRequest(Exception):
    """请求体不合法 —— 回 400（或指定的状态码），并把原因说清楚。"""

    def __init__(self, message: str, code: int = 400) -> None:
        super().__init__(message)
        self.code = code


def sse_chunk(event: str, data) -> bytes:
    """拼一条 SSE 事件。data 走 json.dumps：换行会被转义，不会破坏帧格式。"""
    return f"event: {event}\ndata: {json.dumps(data, ensure_ascii=False)}\n\n".encode("utf-8")



class ClientTracker:
    """数着有几个页面连着（SSE 连接数），顺便当广播台。

    每个 SSE 连接登记一个队列，广播就是往各家的队列里塞事件，由各自的 SSE
    线程按自己的节奏写出去。这样广播方永远不会卡在"连上了但不读数据"的对端上
    （直接写 socket 的话，对方接收窗口满了就会把发信方堵在那儿）。

    `seen` 记"历史上有没有连过"：启动到开窗口之间必然没有客户端，
    不能因为此刻是 0 就判定"窗口关了"。关窗退出只认"连过之后又归零"。
    """

    def __init__(self, queue_size: int = CLIENT_QUEUE) -> None:
        self._lock = threading.Lock()
        self._clients: dict[str, queue.Queue] = {}
        self._seen = 0
        self._seq = 0
        self._queue_size = queue_size

    def add(self) -> tuple[str, queue.Queue]:
        """登记一个新客户端，返回 (客户端 id, 事件队列)。id 用来跳过它自己的回声。"""
        with self._lock:
            self._seq += 1
            cid = f"c{self._seq}"
            sink: queue.Queue = queue.Queue(maxsize=self._queue_size)
            self._clients[cid] = sink
            self._seen += 1
            return cid, sink

    def remove(self, cid: str) -> int:
        with self._lock:
            self._clients.pop(cid, None)
            return len(self._clients)

    @property
    def clients(self) -> int:
        with self._lock:
            return len(self._clients)

    @property
    def seen(self) -> int:
        with self._lock:
            return self._seen

    def broadcast(self, event: str, data, *, skip: str | None = None) -> int:
        """把事件推给所有客户端（skip = 不收自己的回声），返回推给了几个。

        `skip` 是发起者报上来的客户端 id：控制中继不能把动作回给发起者，
        否则会重复触发（在 app 窗口按一次空格，app 自己又跟着执行一次 → 又停了）。
        """
        chunk = sse_chunk(event, data)
        with self._lock:
            targets = [sink for cid, sink in self._clients.items() if cid != skip]
        sent = 0
        for sink in targets:
            try:
                sink.put_nowait(chunk)
                sent += 1
            except queue.Full:
                pass
        return sent


class PrefsStore:
    """页面外观设置的共享副本（主题 / 显示选项 / 轨道配色）。

    内存里存着，同时落一份到盘上（默认 `web/prefs.json`，已 gitignore）：
    内存那份只够"同一次运行内"同步，重启后 OBS 那个浏览器源又得重调外观，
    落盘才叫真的"配一次就一直用"。
    """

    def __init__(self, path: Path | str | None = None) -> None:
        self._lock = threading.Lock()
        self.path = Path(path) if path else None
        self._data: dict = {}
        if self.path is not None:
            try:
                loaded = json.loads(self.path.read_text(encoding="utf-8"))
                if isinstance(loaded, dict):
                    self._data = loaded
            except (OSError, ValueError):
                self._data = {}          # 坏了就当没有：一个设置文件不该让服务起不来

    def snapshot(self) -> dict:
        with self._lock:
            return json.loads(json.dumps(self._data))    # 深拷贝，别让调用方改到内部

    def merge(self, patch: dict) -> tuple[dict, bool]:
        """按顶层键浅合并，返回 (合并后的快照, 有没有真的变化)。

        "内容没变就不算变化"是联动的防回声闸门：两端互相回声也只会来回一次就停。
        """
        if not isinstance(patch, dict):
            raise _BadRequest("prefs 必须是 JSON 对象")
        with self._lock:
            changed = False
            for key, value in patch.items():
                if not isinstance(key, str) or not key or len(key) > 64:
                    raise _BadRequest(f"prefs 的键不合法: {key!r}")
                if not isinstance(value, (dict, list, str, int, float, bool)) and value is not None:
                    raise _BadRequest(f"prefs[{key}] 只能是对象 / 数组 / 标量")
                if self._data.get(key) != value:
                    self._data[key] = value
                    changed = True
            snap = json.loads(json.dumps(self._data))
        if changed:
            self._save()
        return snap, changed

    def _save(self) -> None:
        if self.path is None:
            return
        with self._lock:
            blob = json.dumps(self._data, ensure_ascii=False)
        try:
            self.path.parent.mkdir(parents=True, exist_ok=True)
            tmp = self.path.with_name(self.path.name + ".tmp")
            tmp.write_text(blob, encoding="utf-8")
            tmp.replace(self.path)       # 原子替换：读端不会看到写了一半的 JSON
        except OSError:
            pass                         # 盘上写不了也认成功：内存那份还能用


def make_handler(payload: dict, web_dir: Path, tracker: ClientTracker,
                 prefs: PrefsStore, *, quiet: bool = True):
    """造一个请求处理器类（payload / prefs 闭包进来，JSON 只序列化一次）。"""
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

        def _json(self, obj, code: int = 200) -> None:
            self._send(code, "application/json; charset=utf-8",
                       json.dumps(obj, ensure_ascii=False).encode("utf-8"))

        def _error(self, code: int, message: str) -> None:
            self._json({"ok": False, "error": message}, code)

        def _read_json(self) -> dict:
            """读一个 JSON 对象请求体；不合法就抛 _BadRequest（由调用方回 400）。"""
            try:
                length = int(self.headers.get("Content-Length") or 0)
            except ValueError:
                raise _BadRequest("Content-Length 不是数字")
            if length <= 0:
                return {}
            if length > MAX_POST_BYTES:
                self.close_connection = True    # 不读这坨数据，直接断，免得畸形请求占内存
                raise _BadRequest(f"请求体超过 {MAX_POST_BYTES} 字节", 413)
            raw = self.rfile.read(length)
            try:
                data = json.loads(raw.decode("utf-8"))
            except (ValueError, UnicodeDecodeError):
                raise _BadRequest("请求体不是合法 JSON")
            if not isinstance(data, dict):
                raise _BadRequest("请求体必须是 JSON 对象")
            return data

        @staticmethod
        def _skip_of(data: dict) -> str | None:
            """发起者报上来的客户端 id：广播时跳过它，免得它收到自己的回声。"""
            client = data.get("client")
            return client if isinstance(client, str) and client else None

        # ------------------------------------------------------------ 路由
        def do_GET(self) -> None:              # noqa: N802（基类的命名）
            path = self.path.split("?", 1)[0]
            if path in ("/project.json", "/api/project"):
                return self._send(200, "application/json; charset=utf-8", body)
            if path == "/health":
                return self._json({"ok": True, "clients": tracker.clients})
            if path == "/prefs":
                return self._json(prefs.snapshot())
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

        def do_POST(self) -> None:             # noqa: N802
            path = self.path.split("?", 1)[0]
            if path == "/prefs":
                return self._post_prefs()
            if path == "/control":
                return self._post_control()
            return self._error(404, f"没有这个接口: {path}")

        def _post_prefs(self) -> None:
            """收下这一份外观设置，转给其它窗口（发起者除外）。"""
            try:
                patch = self._read_json()
            except _BadRequest as exc:
                return self._error(exc.code, str(exc))
            skip = self._skip_of(patch)
            patch = {k: v for k, v in patch.items() if k != "client"}
            try:
                snap, changed = prefs.merge(patch)
            except _BadRequest as exc:
                return self._error(exc.code, str(exc))
            sent = tracker.broadcast("prefs", snap, skip=skip) if changed else 0
            return self._json({"ok": True, "changed": changed, "sent": sent})

        def _post_control(self) -> None:
            """控制中继：广播给其它窗口执行（动作必须在白名单里）。"""
            try:
                data = self._read_json()
            except _BadRequest as exc:
                return self._error(exc.code, str(exc))
            action = data.get("action")
            if not isinstance(action, str) or action not in CONTROL_ACTIONS:
                return self._error(400, f"未知动作: {action!r}")
            params = data.get("params")
            if params is None:
                params = {}
            if not isinstance(params, dict):
                return self._error(400, "params 必须是 JSON 对象")
            sent = tracker.broadcast("control", {"action": action, "params": params},
                                    skip=self._skip_of(data))
            return self._json({"ok": True, "action": action, "sent": sent})

        # -------------------------------------------------------------- SSE
        def _events(self) -> None:
            self.send_response(200)
            self.send_header("Content-Type", "text/event-stream; charset=utf-8")
            self.send_header("Connection", "keep-alive")
            for k, v in NO_STORE.items():
                self.send_header(k, v)
            self.end_headers()
            cid, sink = tracker.add()
            try:
                self.wfile.write(b": connected\n\n")
                # 告诉页面它自己的客户端 id：发 /prefs、/control 时带上，
                # 服务端广播就会跳过它，不会自己触发自己。
                self.wfile.write(sse_chunk("hello", {"client": cid}))
                while True:
                    try:
                        # 有事件就立刻发；空闲满 PING_EVERY 秒就发一行注释保活
                        chunk = sink.get(timeout=PING_EVERY)
                    except queue.Empty:
                        chunk = b": ping\n\n"
                    self.wfile.write(chunk)        # 写失败 = 对端没了
            except (BrokenPipeError, ConnectionResetError, OSError):
                pass
            finally:
                tracker.remove(cid)
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
    prefs_path 传了就把设置落盘到那里（app.py 传 web/prefs.json，已 gitignore）；
    不传就只在内存里同步（测试用，免得跑一遍测试就往仓库里写文件）。
    """

    def __init__(self, payload: dict, web_dir: Path, port: int = 8973,
                 *, prefs_path: Path | str | None = None, quiet: bool = True) -> None:
        self.tracker = ClientTracker()
        self.prefs = PrefsStore(prefs_path)
        handler = make_handler(payload, Path(web_dir), self.tracker, self.prefs, quiet=quiet)
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

    @property
    def host_url(self) -> str:
        """app 窗口开的地址（带 ?role=host）。

        带这个参数的那个窗口算"主窗口"：设置以它为准（启动时它用自己的
        localStorage，并把自己那份推到服务端）。OBS 浏览器源用不带参数的
        `url`，它启动时从服务端拉设置 —— 用户不用在浏览器源里重调一遍外观。
        """
        return f"{self.url}?role=host"

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
