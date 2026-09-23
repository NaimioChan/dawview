"""冒烟测试：真窗口能不能打开（起本地服务 + Edge/Chrome 的 app 模式），打印地址。

用法: python scripts/smoke_window.py [工程路径] [持续秒数]

跟 tests/test_server.py 的区别：那些测试打的是 HTTP，这个会真的拉起一个窗口，
用来确认"在这台机器上窗口能开、页面能连上"。
"""
from __future__ import annotations

import sys
import time
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from dawview.app import WEB_DIR, _open_app_window, parse_any, write_snapshot  # noqa: E402
from dawview.server import LocalServer  # noqa: E402

project = sys.argv[1] if len(sys.argv) > 1 else str(
    Path(__file__).resolve().parent.parent / "docs" / "demo-project.json")
hold = int(sys.argv[2]) if len(sys.argv) > 2 else 20

payload = parse_any(project)
write_snapshot(payload)

# 冒烟测试用随机端口：别去抢 8973（那可能正跑着用户自己的实例）
srv = LocalServer(payload, WEB_DIR, port=0).start()
print(f"服务已启动：{srv.url}", flush=True)

proc = _open_app_window(srv.url, 1100, 700)
print(f"窗口进程：{'已拉起 pid=%s' % proc.pid if proc else '没找到 Edge/Chrome'}", flush=True)

if srv.wait_for_client(15):
    print(f"页面已连上（clients={srv.clients}）", flush=True)
else:
    print("15 秒内没有页面连上来 —— 窗口可能没起来，检查一下浏览器", flush=True)

time.sleep(hold)
srv.stop()
if proc:
    proc.terminate()
print("done", flush=True)
