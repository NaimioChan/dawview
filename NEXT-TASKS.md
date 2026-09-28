# NEXT TASKS — dawview

写于 2026-09-22，更新于 2026-09-28，分支 `UI`，**工作区还没 commit**（等用户验证）。

## 这一轮已经做完的（未提交）

### 1. 去 webui2，本地服务换成纯标准库 `dawview/server.py`

- 路由：静态文件（`web/`）、`/project.json`（内存里那份，不读盘）、`/health`、`/events`（SSE 长连接）
- 端口固定 `8973`（`--port` / `DAWVIEW_PORT` 可改）；地址用 `http://localhost:8973/index.html`
  （故意用 `localhost` 而不是 `127.0.0.1`：浏览器把两者当不同的源，保持旧源，localStorage 里的设置才能继承）
- 关窗即退出：靠 `/events` 的客户端计数，"连过之后归零"稳定 1.5 秒才退；`--keep-open` 可以关掉
- 新参数：`--no-window`（只起服务，给 OBS / 外部浏览器）、`--keep-open`、`--port`、`--prefs`
- 零第三方依赖（`requirements.txt` 已删）

### 2. 方案三：OBS 浏览器源当渲染目标，短板在服务端补

服务端（`dawview/server.py`）：

- `/prefs`：外观设置的共享副本（主题 / 显示选项 / 轨道配色 / 缩放）。内存里存着；
  给了 `prefs_path` 就落盘（app.py 传 `web/prefs.json`，已 gitignore，写 `.tmp` 再 `replace` 原子替换）
- `/control`：操作中继，复用已有的 `/events` 广播。带 `client` 的请求不回给发起者（否则自己触发两次）
- `ClientTracker` 改成**每连接一个队列 + 各自线程写出**：直接往 socket 写会被"连上但不读"的
  慢对端卡住（OBS 卡一下就把 app 窗口也拖住）
- 请求体上限 `MAX_POST_BYTES`，超了回 413

前端（`web/app.js`、`web/theme.js`）：

- 保存设置时额外推 `/prefs`；boot 时先拉 `/prefs`（拿不到就用本地 localStorage）
- 会改变"别人看到什么"的操作都 `sendControl(...)`：播放/暂停、定位、缩放、适应窗口、行高、
  视图切换、干净模式、导出模式、轨道显示隐藏、片段名、跟随播放头、轨道选择器
- 地址带 `?role=host` 的窗口是主窗口（app.py 开的那个）：设置以它为准，它一推服务端就跟随
- 播放位置校准：最近被操作过的那个窗口当"时钟主"，每 250ms 报一次位置，
  别的窗口差到约 12px 才纠正一次（每帧都对齐会抖）

顺手修的：

- `fit()` / `zoom()` / `zoomAt()` 现在真的把缩放写进设置 —— 代码注释本来就写着"缩放也记住"，
  但实际只有别的入口会存，于是"缩放记不住"（也让 OBS 那头的缩放对不上）
- `app.py` 启动那两行打印加 `flush=True`：stdout 走管道时是块缓冲，脚本解析不到服务地址
- `verify.mjs` 的导出模式断言先把 `pxPerTick` 钉住（原来缩放小到"内容正好装得下"就没有
  滚动条可藏，断言读到的 0 与实现无关）；detail 里补 `body` / `pxPerTick` / `scrollWidth`

验证状态（都跑过）：

- `python -m pytest tests/ -q` → **73 项**（基线 48 + 多窗口/中继 25）
- `node scripts/verify.mjs` → **53 项 ALL CHECKS PASSED**（主快照 + FL 快照 + 速度轨快照）
- `node scripts/relay-verify.mjs` → **35 项**：两个独立 profile 的 Edge 实例（一个当 app 窗口、
  一个当 OBS 浏览器源）逐项验设置共享、双向中继、host 优先、播放位置校准、无回声风暴

`relay-verify.mjs` 是这轮新加的，自带服务与浏览器实例、跑完自己收摊；CDP 端口默认随机挑
（写死会撞上机器上已有的调试实例，然后一声不吭地连到别人的浏览器上）。

## 下一个任务：候选（按价值排序）

### 1) 滚动位置也联动（现在只同步缩放 / 行高 / 视图）

现象：在 app 窗口里手动横向或纵向滚，OBS 那个画面不动，两边看的不是同一段。

- 中继滚动偏移（谁在滚谁是主，思路照抄播放位置的"时钟主"：带节流，差得看得出来才纠正）
- 或者中继"跟随播放头"的开关，让两边各自跟随（省事，但手动滚依旧不同步）

倾向第一种。注意走带和钢琴窗的滚动状态是分开的，中继时要带视图标识，
别把钢琴窗的滚动套到走带上。

### 2) OBS 浏览器源透明背景（alpha 叠层）

浏览器源天生带 alpha（window capture 不行）。加一个"透明背景"开关（背景不画、格线可留），
OBS 侧勾"允许透明"。要确认它和导出模式叠加时不把内容也弄透明。

### 3) `docs/obs.md`：把 OBS 侧的用法写全

源类型 / 尺寸 / 帧率 / 自定义 CSS / 是否透明 / 混音器要不要静音 + 截图。
README 现在只有一小段，真要配 OBS 的人需要一份照着能做的。

### 4) 录制要不要内录（暂时不做）

`canvas.captureStream` + MediaRecorder（实测 Edge 153 支持 `video/mp4`），
只能录画面、录不到声音，和 OBS 职责重叠，暂不做。

## OBS 事实（查过源码，别再信内容农场）

- **Client Area**：OBS 里确实有（`plugins/win-capture/window-capture.c`，属性名 `client_area`，默认 true），
  但**只在 Capture Method 选「Windows 10 (WGC)」时才显示**（`obs_property_set_visible(p, wgc_options)`）。
  所以找不到它 → 把捕获方式从 "Automatic" 改成 "Windows 10 (WGC)" 再看。
- **黄色捕获边框**：OBS 自己会调 `session.IsBorderRequired(false)`
  （`libobs-winrt/winrt-capture.cpp`），支持的系统上不用手动关。
- **声音**：window capture 有 `capture_audio` 选项；dawview 不解析音频，要带音乐录只能靠 OBS。

## 环境备忘

- 前端验证的静态服务 + 无头浏览器（`verify.mjs` 需要）：
  `python -m http.server 8765 --bind 127.0.0.1 --directory web` +
  无头 Edge `--headless=new --remote-debugging-port=9223 --user-data-dir=<临时目录>`
  （`relay-verify.mjs` 不需要这两个，它自己起、自己收）
- 本机开着代理时，curl / urllib 打 127.0.0.1 要显式绕开（`curl --noproxy '*'`）
- 本机 `python` 是 3.14（pytest 已装）、Node 26
- 主力机已修好、Hermes 配置也迁过来了（`%LOCALAPPDATA%\hermes`）；这台机器上的项目在
  `C:\Users\Naimio\projects\dawview`（轻薄本上另有一份）
