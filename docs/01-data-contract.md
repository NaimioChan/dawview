# dawview 数据契约 (v0.2)

> 解析器（Python 后端）与 WebUI 前端之间的唯一接口。
> 改契约 = 改这个文件头部 changelog + 两端同步。
> 方向：后端 → 前端单向推送（`loadProject`），前端不回传数据。

## Changelog
- v0.2 (2026-09-22): 支持 FL Studio `.flp`。片段种类加 `automation` / `other`
  （FL 的自动化片段是工程里的大头），轨道种类加 `automation`。
- v0.1 (2026-09-22): 初版。轨道/部件/音符/自动化/全局信息。

## 顶层结构

```jsonc
{
  "meta": {
    "host": "cubase",             // cubase | fl | bitwig (未来)
    "hostVersion": "15.0.30",
    "projectName": "26.9.6 lulabi",
    "bpm": 76.0,                  // 首拍速度；tempoMap 有完整曲线
    "timeSig": [4, 4],            // 首拍拍号
    "ppq": 480,                   // ticks per quarter note
    "sampleRate": 48000
  },
  "tempoMap":   [[tick, bpm], ...],          // 升序
  "markers":    [[tick, "名字"], ...],
  "tracks":     [Track, ...],               // 自上而下的显示顺序
  "lengthTicks": 26240                       // 工程末尾（含最后一个事件 + 一小节余量）
}
```

## Track

```jsonc
{
  "id": "t0",
  "name": "Pianoteq 8 01",
  "kind": "instrument",        // instrument | midi | audio | automation | folder | bus | marker | tempo | other
  "clips": [Clip, ...]         // 部件/片段，按 startTick 升序
}
```

## Clip

```jsonc
{
  "id": "c0",
  "name": "Pianoteq 8 01",
  "kind": "midi",              // midi | audio | automation | other
  "startTick": 0,
  "lengthTick": 2624,
  "notes": [Note, ...],        // 仅 midi；其余为空数组
  "audioFile": "voc\\_lead.wav" // 仅 audio；解析器原样给出宿主里的路径
}
```

- `midi`：宿主里的"模式/部件"（Cubase 的 MIDI part、FL 的 Pattern），`notes` 相对片段起点。
- `audio`：音频片段（FL 的 Sampler/渲染音频通道），有 `audioFile`。
- `automation`：自动化片段（FL 的插件参数自动化）。**没有音频、也没有音符**，
  前端画成纯色块（不画假波形），底色用主题的 `--clip-auto`。
- `other`：宿主里存在、但类型没认出来的片段；前端用中性色渲染。

## 宿主解析器

| 扩展名 | 模块 | 实测版本 |
|---|---|---|
| `.cpr` | `dawview/cpr_parser.py` | Cubase 15.0.30 WIN64 |
| `.flp` | `dawview/flp_parser.py` | FL Studio 25.2.4.5242 |

两种格式的**线格式（wire format）笔记写在各自解析器的 docstring 里**（都是实测逆向出来的：
字段偏移、事件 ID、踩过的坑），本文件只管两端之间的 JSON 契约。

FL 特有的两点（都会影响契约字段）：

- **速度是反推出来的**：FL 25 的 `.flp` 里没有速度事件。解析器拿音频片段的
  "源文件时长(ms) / 片段长度(tick)" 当每 tick 毫秒数，众数 + 整数速度优先 → `bpm`。
  万古城.flp：557 个片段一致给出 3.612717 ms/tick = 173.000 BPM。
- **采样率不在文件里**：`sampleRate` 只能给默认 44100 并在 `warnings` 里说明。

## Note

```jsonc
{
  "startTick": 240,            // 相对 clip 起点
  "lengthTick": 480,
  "pitch": 60,                 // MIDI note number 0-127
  "velocity": 100              // 1-127
}
```

## AutomationTrack (v0.2 预留，本期不渲染曲线)

```jsonc
{ "trackId": "t0", "param": "Volume", "points": [[tick, normValue01], ...] }
```

## 未解析内容的降级规则

- 音符解不出来 → `notes: []`，clip 仍显示色块（名字+位置正确）。
- 轨道名缺失 → 用 `轨道 N`（FL 固定写满 500 条轨道，没名字又没片段的直接不输出）。
- 未知轨道类型 → `kind: "other"`，前端按中性色渲染。
- 未知片段类型 → `kind: "other"`，前端按中性色渲染（不画假波形）。

## 铁律

1. tick 是唯一时间单位；前端用 `ppq` + tempoMap 换算秒。
2. 所有 startTick 绝对时间（相对工程起点）；Note.startTick 相对 clip。
3. 解析失败不得崩溃：单轨/单 clip 失败跳过并记 warning，其余照常显示。

## 取数通道（webui 桥）

前端优先走 webui 桥，失败才回退同目录 `project.json`（回退只为便于无头浏览器验证）。
桥上有两个后端函数：

| 函数 | 方向 | 说明 |
|---|---|---|
| `loadProject()` | 前端 → 后端 | 返回契约 JSON（见上），**唯一数据入口** |
| `clientReady()` | 前端 → 后端 | boot 完成后的握手，后端据此判断窗口真的连上了 |

### webui2 在本机的实测坑（都已在代码里规避）

- 响应必须用 `event.return_string(...)` 送回；**Python 回调的 return 值不会到前端**（实测拿到空字符串）。
- `window.webui` 由 `webui.js` 在 DOMContentLoaded 创建，且要等 WebSocket 连上（`webui.isConnected()`）调用才有效 —— 页面必须引入 `<script src="webui.js"></script>`，前端要等到「桥存在且已连接」再取数。
- `show()` / `show_browser()` 本机失效：`browser_exist(Edge)` 直接抛访问违规，`show()` 返回 False 后连 HTTP 服务都会一起关掉（用户只看到空白窗口）。改用 `start_server("index.html")`（只起服务、返回 `http://localhost:<port>`），窗口由 `_open_app_window()` 用浏览器 app 模式拉起（独立 profile，不碰用户主浏览器）。
- `show()` / `is_shown()` 的返回值都不可信；进程不要用 `webui.wait()` 保活（超时即返回、服务器随之消失），改为等 `EventType.DISCONNECTED` 再退出。

## 显示选项不进契约

干净模式、片段名开关、跟随方式（翻页/居中）、行高（走带行高 / 钢琴窗半音行高）、
视图模式（走带/钢琴窗）、播放速度、动效（开关与强度/余韵）、**哪些轨道显示/隐藏**、
**每条轨道的颜色**、配色 ——
这些纯前端偏好只存 `localStorage`（`dawview.view` / `dawview.theme` / `dawview.trackColors`），
**不进数据契约、不回传后端**。
契约只描述"工程长什么样"，显示方式由使用者自己定。

轨道颜色按工程分桶存（`dawview.trackColors = { "<工程名>": { "<轨道下标>": "#rrggbb" } }`），
键是**工程里的轨道下标**：前端过滤隐藏轨道后会另挂一个 `projectIndex` 字段给绘制层用
（`view.tracks` 的下标 ≠ 工程下标），这个字段只在内存里，不属于契约。
「按种类快筛」（`kindFilter`）与「渐变上色」（沿色卡调色板 / 色相环给显示中的轨道批量配色）
都是在这两个已有结构上做文章：前者只改 `hiddenTracks`，后者只写 `trackColors`，
契约里没有新增任何字段。

主题清单（深 7 / 浅 5，见 `web/theme.js`）同样是纯前端的：后端不认识"主题"这个概念，
契约里也没有任何颜色字段 —— 颜色全由前端按主题变量现算。
契约里的 `kind` 只决定"用哪个变量"（midi / audio / automation / other → `--clip-midi` /
`--clip-audio` / `--clip-auto` / `--muted`），具体色值由主题给。

MIDI 钢琴窗视图也只吃契约里已有的字段（`tracks[].clips[].notes[]` 的
`pitch / startTick / lengthTick / velocity`），**没有为它新增契约字段** ——
换宿主解析器时前端不用改。
