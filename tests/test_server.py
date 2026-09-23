"""dawview/server.py 的单元测试 —— 不依赖浏览器，直接打 HTTP。

覆盖：静态文件、/project.json（内存里的那份）、/health、SSE 客户端计数、
关窗判定（wait_all_closed）、端口占用报错、以及 ../ 越界访问。
"""
from __future__ import annotations

import http.client
import json
import socket
import threading
import time
import urllib.error
import urllib.request
from pathlib import Path

import pytest

from dawview.server import LocalServer

ROOT = Path(__file__).resolve().parent.parent
WEB = ROOT / "web"
DEMO = json.loads((ROOT / "docs" / "demo-project.json").read_text(encoding="utf-8"))

# 本机开着代理时 urllib 会把 127.0.0.1 也丢给代理，测试要显式绕过
OPENER = urllib.request.build_opener(urllib.request.ProxyHandler({}))


@pytest.fixture()
def server():
    srv = LocalServer(DEMO, WEB, port=0).start()
    yield srv
    srv.stop()


def get(server, path, *, raw: bool = False):
    url = f"http://127.0.0.1:{server.port}{path}"
    try:
        with OPENER.open(url, timeout=5) as res:
            body = res.read()
            return res.status, dict(res.headers), body if raw else body.decode("utf-8")
    except urllib.error.HTTPError as exc:          # 4xx 也当结果返回
        return exc.code, dict(exc.headers), exc.read().decode("utf-8", "replace")


# ------------------------------------------------------------------ 基本路由

def test_health(server):
    status, headers, body = get(server, "/health")
    assert status == 200
    assert json.loads(body) == {"ok": True, "clients": 0}
    assert "no-store" in headers.get("Cache-Control", "")


def test_project_json_comes_from_memory(server):
    status, headers, body = get(server, "/project.json")
    assert status == 200
    assert json.loads(body) == DEMO                     # 与传入的 payload 完全一致
    assert "no-store" in headers.get("Cache-Control", "")
    # 不读盘：把盘上的文件改掉也不该影响服务（内存里那份是权威）
    disk = WEB / "project.json"
    before = disk.read_bytes() if disk.exists() else None
    try:
        disk.write_text('{"tracks": []}', encoding="utf-8")
        _, _, again = get(server, "/project.json")
        assert json.loads(again) == DEMO
    finally:
        if before is not None:
            disk.write_bytes(before)


def test_static_files_and_root(server):
    status, headers, body = get(server, "/index.html")
    assert status == 200
    assert body == (WEB / "index.html").read_text(encoding="utf-8")
    assert headers["Content-Length"] == str((WEB / "index.html").stat().st_size)

    # 根路径等价于 index.html
    status, _, root_body = get(server, "/")
    assert status == 200 and root_body == body

    status, _, css = get(server, "/style.css")
    assert status == 200 and css == (WEB / "style.css").read_text(encoding="utf-8")


def test_unknown_path_is_404(server):
    assert get(server, "/nope.js")[0] == 404
    assert get(server, "/health.json")[0] == 404


def test_favicon_is_quiet_204(server):
    assert get(server, "/favicon.ico")[0] == 204


def test_head_project_json(server):
    conn = http.client.HTTPConnection("127.0.0.1", server.port, timeout=5)
    conn.request("HEAD", "/project.json")
    res = conn.getresponse()
    assert res.status == 200
    assert res.getheader("Content-Length") == str(len(json.dumps(DEMO, ensure_ascii=False).encode()))
    assert res.read() == b""
    conn.close()


# ------------------------------------------------------------------ 安全

@pytest.mark.parametrize("path", [
    "/../dawview/app.py",
    "/%2e%2e/dawview/app.py",
    "/..%2f..%2fdawview%2fcpr_parser.py",
    "/static/../../dawview/server.py",
])
def test_no_path_traversal(server, path):
    status, _, body = get(server, path)
    assert status in (400, 404)
    assert "parse_cpr" not in body and "def make_handler" not in body


# ------------------------------------------------------------------ SSE / 关窗判定

class SseClient:
    """裸 socket 连 /events，用来精确控制"连上/断开"。"""

    def __init__(self, port: int) -> None:
        self.sock = socket.create_connection(("127.0.0.1", port), timeout=5)
        self.sock.sendall(b"GET /events HTTP/1.1\r\nHost: 127.0.0.1\r\n\r\n")
        self.buf = b""
        while b"\r\n\r\n" not in self.buf:
            chunk = self.sock.recv(4096)
            if not chunk:
                raise RuntimeError("SSE 连接被关掉了")
            self.buf += chunk

    def close(self) -> None:
        try:
            self.sock.shutdown(socket.SHUT_RDWR)
        except OSError:
            pass
        self.sock.close()


def wait_until(pred, timeout=5.0, step=0.02) -> bool:
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        if pred():
            return True
        time.sleep(step)
    return False


def test_sse_counts_clients(server):
    assert server.clients == 0
    c1 = SseClient(server.port)
    assert wait_until(lambda: server.clients == 1)
    assert json.loads(get(server, "/health")[2])["clients"] == 1
    c2 = SseClient(server.port)
    assert wait_until(lambda: server.clients == 2)
    c1.close()
    assert wait_until(lambda: server.clients == 1)
    c2.close()
    assert wait_until(lambda: server.clients == 0)
    assert server.tracker.seen == 2


def test_wait_all_closed_returns_after_disconnect(server):
    client = SseClient(server.port)
    assert server.wait_for_client(2.0)

    done = threading.Event()

    def waiter():
        done.set() if server.wait_all_closed(grace=0.2) else None

    t = threading.Thread(target=waiter, daemon=True)
    t.start()
    time.sleep(0.3)
    assert not done.is_set()               # 还连着，不能退出
    client.close()
    assert wait_until(done.is_set, timeout=3)
    t.join(timeout=1)


def test_wait_for_client_times_out(server):
    assert server.wait_for_client(0.2) is False
    client = SseClient(server.port)
    assert server.wait_for_client(2.0) is True
    client.close()


def test_wait_all_closed_without_any_client(server):
    """一个客户端都没来过时必须返回 False —— 否则"启动到开窗口"之间就把自己判死了。"""
    assert server.wait_all_closed(grace=0.1) is False


# ------------------------------------------------------------------ 端口

def test_busy_port_raises_oserror(server):
    with pytest.raises(OSError):
        LocalServer(DEMO, WEB, port=server.port)


def test_ephemeral_port_is_random_and_free():
    a = LocalServer(DEMO, WEB, port=0).start()
    b = LocalServer(DEMO, WEB, port=0).start()
    try:
        assert a.port and b.port and a.port != b.port
        assert get(a, "/health")[0] == 200
    finally:
        a.stop()
        b.stop()
