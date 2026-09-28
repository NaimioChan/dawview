"""dawview/server.py 的单元测试 —— 不依赖浏览器，直接打 HTTP。

覆盖：静态文件、/project.json（内存里的那份）、/health、SSE 客户端计数、
关窗判定（wait_all_closed）、端口占用报错、以及 ../ 越界访问。
"""
from __future__ import annotations

import http.client
import json
import re
import socket
import threading
import time
import urllib.error
import urllib.request
from pathlib import Path

import pytest

from dawview.server import CONTROL_ACTIONS, MAX_POST_BYTES, LocalServer

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
    """裸 socket 连 /events，用来精确控制"连上/断开"，并读广播过来的事件。"""

    def __init__(self, port: int) -> None:
        self.sock = socket.create_connection(("127.0.0.1", port), timeout=5)
        self.sock.sendall(b"GET /events HTTP/1.1\r\nHost: 127.0.0.1\r\n\r\n")
        buf = b""
        while b"\r\n\r\n" not in buf:
            chunk = self.sock.recv(4096)
            if not chunk:
                raise RuntimeError("SSE 连接被关掉了")
            buf += chunk
        _, _, self.buf = buf.partition(b"\r\n\r\n")     # 头之后的部分留给 read_event

    def read_event(self, timeout: float = 3.0):
        """读一条事件（跳过 `:` 开头的保活注释行），返回 (event, data)。"""
        deadline = time.monotonic() + timeout
        while True:
            while b"\n\n" in self.buf:
                frame, _, self.buf = self.buf.partition(b"\n\n")
                text = frame.decode("utf-8", "replace")
                if text.startswith(":"):        # 保活注释
                    continue
                event, data = "", []
                for line in text.splitlines():
                    if line.startswith("event: "):
                        event = line[7:]
                    elif line.startswith("data: "):
                        data.append(line[6:])
                return event, (json.loads("\n".join(data)) if data else None)
            left = deadline - time.monotonic()
            if left <= 0:
                raise TimeoutError("等不到 SSE 事件")
            self.sock.settimeout(left)
            try:
                chunk = self.sock.recv(4096)
            except socket.timeout:
                raise TimeoutError("等不到 SSE 事件")
            if not chunk:
                raise RuntimeError("SSE 连接被关掉了")
            self.buf += chunk

    def read_until(self, name: str, timeout: float = 3.0):
        """读到指定名字的事件为止（读的过程中会把别的都丢掉）。"""
        deadline = time.monotonic() + timeout
        while True:
            left = max(0.05, deadline - time.monotonic())
            event, data = self.read_event(left)
            if event == name:
                return data

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


# ------------------------------------------------- /prefs：外观设置的共享副本

def post(server, path, payload=None, *, raw: bytes | None = None):
    """POST 一个 JSON 体，返回 (状态码, 解析后的 JSON)。4xx 也当结果返回。"""
    url = f"http://127.0.0.1:{server.port}{path}"
    body = raw if raw is not None else json.dumps(payload, ensure_ascii=False).encode("utf-8")
    req = urllib.request.Request(url, data=body, method="POST",
                                 headers={"Content-Type": "application/json"})
    try:
        with OPENER.open(req, timeout=5) as res:
            return res.status, json.loads(res.read().decode("utf-8"))
    except urllib.error.HTTPError as exc:
        return exc.code, json.loads(exc.read().decode("utf-8"))


def test_prefs_starts_empty(server):
    status, _, body = get(server, "/prefs")
    assert status == 200
    assert json.loads(body) == {}


def test_prefs_post_then_get_roundtrip(server):
    payload = {"view": {"rowH": 48, "viewMode": "midi"},
               "theme": {"name": "midnight", "custom": {}},
               "colors": {"project": "示例", "map": {"0": "#3389d1"}}}
    status, body = post(server, "/prefs", payload)
    assert status == 200
    assert body == {"ok": True, "changed": True, "sent": 0}   # 没有页面连着，广播给 0 个
    assert json.loads(get(server, "/prefs")[2]) == payload


def test_prefs_client_id_is_not_stored(server):
    """client 只是"别回给我自己"的标记，不该混进设置本身。"""
    post(server, "/prefs", {"view": {"rowH": 30}, "client": "c1"})
    assert "client" not in json.loads(get(server, "/prefs")[2])


def test_prefs_broadcast_skips_sender(server):
    a = SseClient(server.port)
    b = SseClient(server.port)
    try:
        assert wait_until(lambda: server.clients == 2)
        a_id = a.read_until("hello")["client"]
        b.read_until("hello")
        status, body = post(server, "/prefs", {"view": {"rowH": 44}, "client": a_id})
        assert body == {"ok": True, "changed": True, "sent": 1}
        assert b.read_until("prefs")["view"]["rowH"] == 44
        # 发起者收不到自己的回声（否则两端会互相回声不止）
        with pytest.raises(TimeoutError):
            a.read_event(0.4)
    finally:
        a.close()
        b.close()


def test_prefs_unchanged_is_not_broadcast(server):
    """内容没变就不算变化 —— 这是联动的防回声闸门。"""
    client = SseClient(server.port)
    try:
        client.read_until("hello")
        payload = {"view": {"rowH": 50}}
        assert post(server, "/prefs", payload)[1]["changed"] is True
        assert client.read_until("prefs")["view"]["rowH"] == 50
        assert post(server, "/prefs", payload)[1] == {"ok": True, "changed": False, "sent": 0}
        with pytest.raises(TimeoutError):
            client.read_event(0.4)
    finally:
        client.close()


def test_prefs_merge_is_by_top_level_key(server):
    """按顶层键浅合并：只发 view 的那次不该把 theme 冲掉。"""
    post(server, "/prefs", {"view": {"rowH": 22}, "theme": {"name": "day"}})
    post(server, "/prefs", {"view": {"rowH": 66}})
    snap = json.loads(get(server, "/prefs")[2])
    assert snap["view"] == {"rowH": 66}
    assert snap["theme"] == {"name": "day"}


@pytest.mark.parametrize("raw, needle", [
    (b"{not json", "不是合法 JSON"),
    (b"[1, 2, 3]", "必须是 JSON 对象"),
    (b'"just a string"', "必须是 JSON 对象"),
])
def test_prefs_rejects_bad_body(server, raw, needle):
    status, body = post(server, "/prefs", raw=raw)
    assert status == 400
    assert body["ok"] is False and needle in body["error"]
    assert json.loads(get(server, "/prefs")[2]) == {}      # 坏请求什么都不该留下


def test_prefs_rejects_bad_key(server):
    status, body = post(server, "/prefs", {"x" * 70: {"rowH": 1}})
    assert status == 400 and "键不合法" in body["error"]


def test_prefs_oversized_body_is_413(server):
    """超限的请求体不读、直接回 413：所以这里只发头声明长度，不真发那坨数据。"""
    conn = http.client.HTTPConnection("127.0.0.1", server.port, timeout=5)
    conn.putrequest("POST", "/prefs")
    conn.putheader("Content-Length", str(MAX_POST_BYTES + 1))
    conn.putheader("Content-Type", "application/json")
    conn.endheaders()
    res = conn.getresponse()
    assert res.status == 413
    assert json.loads(res.read().decode("utf-8"))["ok"] is False
    conn.close()


def test_prefs_persist_to_disk(tmp_path):
    """落盘那份是给"重启后 OBS 浏览器源还得有设置"用的。"""
    path = tmp_path / "prefs.json"
    srv = LocalServer(DEMO, WEB, port=0, prefs_path=path).start()
    try:
        post(srv, "/prefs", {"view": {"rowH": 60}})
        assert json.loads(path.read_text(encoding="utf-8"))["view"]["rowH"] == 60
        assert not (tmp_path / "prefs.json.tmp").exists()   # 原子替换不留临时文件
    finally:
        srv.stop()
    again = LocalServer(DEMO, WEB, port=0, prefs_path=path).start()
    try:
        assert json.loads(get(again, "/prefs")[2])["view"]["rowH"] == 60
    finally:
        again.stop()


def test_prefs_corrupt_file_is_ignored(tmp_path):
    path = tmp_path / "prefs.json"
    path.write_text("{ 这不是 JSON", encoding="utf-8")
    srv = LocalServer(DEMO, WEB, port=0, prefs_path=path).start()
    try:
        assert json.loads(get(srv, "/prefs")[2]) == {}       # 坏了当没有，不该起不来
        assert post(srv, "/prefs", {"view": {"rowH": 20}})[0] == 200
    finally:
        srv.stop()


def test_server_without_prefs_path_writes_nothing(server):
    """测试里不传 prefs_path：只在内存里同步，不该往仓库里写文件。"""
    post(server, "/prefs", {"view": {"rowH": 21}})
    assert server.prefs.path is None


# ------------------------------------------- /control：操作中继（OBS 画面跟着走）

def test_control_broadcasts_across_clients(server):
    a = SseClient(server.port)
    b = SseClient(server.port)
    try:
        assert wait_until(lambda: server.clients == 2)
        a_id = a.read_until("hello")["client"]
        b.read_until("hello")
        status, body = post(server, "/control", {"action": "toggleplay", "client": a_id})
        assert status == 200
        assert body == {"ok": True, "action": "toggleplay", "sent": 1}
        assert b.read_until("control") == {"action": "toggleplay", "params": {}}
        # 发起者不能再执行一遍（按一次空格变成"播了又停"就是这么来的）
        with pytest.raises(TimeoutError):
            a.read_event(0.4)
    finally:
        a.close()
        b.close()


def test_control_keeps_params(server):
    client = SseClient(server.port)
    try:
        client.read_until("hello")
        post(server, "/control", {"action": "seek", "params": {"tick": 1920}})
        assert client.read_until("control")["params"] == {"tick": 1920}
    finally:
        client.close()


def test_control_without_clients_is_ok(server):
    status, body = post(server, "/control", {"action": "play"})
    assert status == 200
    assert body == {"ok": True, "action": "play", "sent": 0}


@pytest.mark.parametrize("payload, needle", [
    ({"action": "rm -rf /"}, "未知动作"),
    ({}, "未知动作"),
    ({"action": 12}, "未知动作"),
    ({"action": "play", "params": [1, 2]}, "params 必须是 JSON 对象"),
])
def test_control_rejects_bad_requests(server, payload, needle):
    status, body = post(server, "/control", payload)
    assert status == 400
    assert body["ok"] is False and needle in body["error"]


def test_control_rejects_bad_actions_without_broadcasting(server):
    client = SseClient(server.port)
    try:
        client.read_until("hello")
        post(server, "/control", {"action": "nope"})
        with pytest.raises(TimeoutError):
            client.read_event(0.4)
    finally:
        client.close()


def test_post_unknown_path_is_404(server):
    assert post(server, "/nope", {})[0] == 404


def test_get_on_post_only_routes_is_404(server):
    assert get(server, "/control")[0] == 404


def test_frontend_actions_match_server_whitelist():
    """前端 CONTROL_ACTIONS 的键必须和服务端白名单一模一样。

    少了：服务端根本不放行，动作发不出去（静默失灵，最难查的那类 bug）。
    多了：白名单形同虚设。两个文件在不同语言里，靠这条测试钉住。
    """
    js = (ROOT / "web" / "app.js").read_text(encoding="utf-8")
    block = js.split("const CONTROL_ACTIONS = {", 1)[1].split("\n};", 1)[0]
    keys = set(re.findall(r"^\s{2}([A-Za-z]+):", block, re.M))
    assert keys, "没从 app.js 里解析出 CONTROL_ACTIONS"
    assert keys == set(CONTROL_ACTIONS)
