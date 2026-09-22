"""冒烟测试：真实 webui 窗口能否打开，并打印其本地服务端口。

用法: python scripts/smoke_window.py [工程路径] [持续秒数]
"""
from __future__ import annotations

import json
import sys
import time
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from dawview.app import WEB_DIR, parse_any, write_snapshot  # noqa: E402

project = sys.argv[1] if len(sys.argv) > 1 else \
    r"D:\Users\Naimio\Documents\Projects\26.9.16\26.9.6 lulabi.cpr"
hold = int(sys.argv[2]) if len(sys.argv) > 2 else 25

payload = parse_any(project)
write_snapshot(payload)

from webui import webui as webui_mod  # noqa: E402

w = webui_mod.Window()
w.set_root_folder(str(WEB_DIR))
w.bind("loadProject", lambda _e: json.dumps(payload, ensure_ascii=False))
w.set_size(1100, 700)
ok = w.show("index.html")
print(f"show={ok} port={w.get_port()} url={w.get_url()}", flush=True)
print(f"window_id={w.get_window_id()} shown={w.is_shown()}", flush=True)

time.sleep(hold)
w.destroy()
print("destroyed", flush=True)
