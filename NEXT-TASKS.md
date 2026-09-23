# NEXT TASKS — dawview

写于 2026-09-22，分支 `UI`，**工作区还没 commit**（等用户验证）。

## 这一轮已经做完的（未提交）

去掉了 webui2，本地服务换成纯标准库的 `dawview/server.py`：

- 路由：静态文件（`web/`）、`/project.json`（内存里那份，不读盘）、`/health`、`/events`（SSE 长连接）
- 端口固定 `8973`（`--port` / `DAWVIEW_PORT` 可改）；地址用 `http://localhost:8973/index.html`
  （故意用 `localhost` 而不是 `127.0.0.1`：浏览器把两者当不同的源，保持旧源，localStorage 里的设置才能继承）
- 关窗即退出：靠 `/events` 的客户端计数，"连过之后归零"稳定 1.5 秒才退；`--keep-open` 可以关掉
- 新参数：`--no-window`（只起服务，给 OBS / 外部浏览器）、`--keep-open`、`--port`
- 零第三方依赖（`requirements.txt` 已删）

验证状态：`pytest tests/ -q` → 48 项；`node scripts/verify.mjs` → 52 项 ALL CHECKS PASSED
（主快照 + FL 快照 + 速度轨快照）；真浏览器端到端验过（关窗后进程 1 秒内退出）。

## 下一个任务：方案三 —— OBS 浏览器源当渲染目标，短板在服务端补

目标：OBS 里加「浏览器」源指向 `http://localhost:8973/index.html` 当画面，
用 app 窗口（或任何窗口）操作，OBS 那个画面跟着走。
浏览器源的好处：天生没边框、支持透明通道（alpha 叠层）、不受窗口遮挡影响、分辨率可超采样。

### 1) 设置同步（`/prefs`）

问题：OBS 浏览器源是独立浏览器实例，`localStorage` 跟 app 窗口不是一份，主题/配色/缩放要重调。

- 前端保存设置时（主题切换、`saveViewPrefs`、`saveTrackColors`）额外 POST 一份到 `/prefs`
- 任何页面 boot 时先 GET `/prefs`，拿到就套用，拿不到就用本地 localStorage
- 服务端存内存即可；要持久化就写 `web/prefs.json`（记得加进 `.gitignore`）
- 要同步的键：`dawview.view`、`dawview.theme`、`dawview.trackColors`

涉及：`web/app.js`（保存/加载设置那几处）、`dawview/server.py`

### 2) 控制中继（`/control`）

问题：OBS 浏览器源不能用键盘（"Interact" 能转发键鼠，但录制时要一直让那个小窗保持焦点，别扭）。

- app 窗口里的操作 → POST `/control`（动作名 + 参数）→ 服务端通过已有的 `/events` 广播 →
  各页面执行同样动作。于是"你在普通窗口里按空格，OBS 画面跟着播"
- 发起者要跳过自己收到的广播（带 client id 或直接不发给发起者），否则会重复触发
- 要支持的动作：播放/暂停、定位（点标尺 / 拖播放头）、缩放、行高、
  视图切换（走带/钢琴窗）、干净模式、导出模式、轨道显示隐藏

涉及：`dawview/server.py`（`/control` + 广播）、`web/app.js`（按键处理里顺带发一份，SSE 收到就执行）

## OBS 事实（查过源码，别再信内容农场）

- **Client Area**：OBS 里确实有（`plugins/win-capture/window-capture.c`，属性名 `client_area`，默认 true），
  但**只在 Capture Method 选「Windows 10 (WGC)」时才显示**（`obs_property_set_visible(p, wgc_options)`）。
  所以找不到它 → 把捕获方式从 "Automatic" 改成 "Windows 10 (WGC)" 再看。
- **黄色捕获边框**：OBS 自己会调 `session.IsBorderRequired(false)`
  （`libobs-winrt/winrt-capture.cpp`），支持的系统上不用手动关。
- **声音**：window capture 有 `capture_audio` 选项；dawview 不解析音频，要带音乐录只能靠 OBS。

## 其他待定

- 录制要不要透明背景（alpha 叠层）—— 浏览器源支持，window capture 不支持
- 要不要 dawview 内录：`canvas.captureStream` + MediaRecorder（实测 Edge 153 支持 `video/mp4`），
  只能录画面、录不到声音，和 OBS 职责重叠，暂不做

## 环境备忘

- 前端验证要两个后台进程：
  `python -m http.server 8765 --bind 127.0.0.1 --directory web` +
  无头 Edge `--headless=new --remote-debugging-port=9223 --user-data-dir=<临时目录>`
- 本机开着代理时，curl / urllib 打 127.0.0.1 要显式绕开（`curl --noproxy '*'`）
- 主力机修好后要把 Hermes 配置迁过去（`%LOCALAPPDATA%\hermes`：config、skills、plugins、cron）
