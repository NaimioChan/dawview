# dawview 数据契约 (v0.5)

> 解析器（Python 后端）与 WebUI 前端之间的唯一接口。
> 改契约 = 改这个文件头部 changelog + 两端同步。
> 方向：后端 → 前端单向推送（`loadProject`），前端不回传数据。

## Changelog
- v0.5 (2026-09-28): 支持 Bitwig Studio `.bwproject`。`host` 加 `bitwig`；ppq 480（Bitwig 内部就是
  480）。`.bwproject` 是**二进制容器**（头部 + meta 块 + 元素流文档），契约本身没变 —— 位置/时长/
  力度在文件里都是“拍”，解析器乘 480 变 tick。三处要点写进了解析器 docstring：
  **音高写在“音高轨”的 footer 上**（字段 0xee + 1 字节，落在它那条轨的音符之后；
  音高轨按音高降序排列，所以某音符的音高 = 排在它后面最近的 footer），音符记录里没有音高字段；
  **片段实例按“轨道片段列表头”归轨**（字段 (0x238, tag 0x09)，逐轨一份；
  片段字段区里的 (0x288, tag 0x09) 是宿主 class，0xbf 乐器 / 0x105 音频；
  列表头下标 ≠ 轨道下标 —— 中间夹着 4 个空组（FX 轨 / Master），按“能放这种片段的轨道”
  顺序对齐：MIDI 组 ↔ 乐器轨、音频组 ↔ 混合轨）——
  复制粘贴出来的片段是各自独立的片段对象，**必须逐段解出来**（早期版本只认带元素头标记的
  元素，于是“每轨只剩一段”）；**一条轨的音频片段名只在第一段的样本记录里出现**，
  后面几段要顺着往前补，可疑处记进 `warnings`。
- v0.4 (2026-09-28): 支持 REAPER `.rpp`。`host` 加 `reaper`；ppq 960（REAPER 的 MIDI 源固定
  960）。RPP 是**纯文本**工程，里面的时间全是**秒**（片段位置/长度、标记、速度轨点的位置），
  解析器按阶梯速度轨积分成 tick 再进契约 —— 契约本身没变。轨道种类多了 `folder`
  （REAPER 的文件夹父轨）；`controllers` 现在也由 REAPER 填充（事件流里的 `0xBn`）。
- v0.3 (2026-09-22): 变速播放。`tempoMap` 从"单点占位"变成真·速度轨
  （Cubase 速度轨 1129 点 / FL 速度自动化曲线），语义定为**阶梯（hold）**：
  tick t 的速度 = 最后一个 tick ≤ t 的点的 bpm。片段新增 `controllers`
  （CC 曲线，给钢琴窗下部自定义栏用）。音符力度改用真正的力度字节
  （Cubase 的 `VffO` 恒为 0.5，不是力度）。
- v0.2 (2026-09-22): 支持 FL Studio `.flp`。片段种类加 `automation` / `other`
  （FL 的自动化片段是工程里的大头），轨道种类加 `automation`。
- v0.1 (2026-09-22): 初版。轨道/部件/音符/自动化/全局信息。

## 顶层结构

```jsonc
{
  "meta": {
    "host": "cubase",             // cubase | fl | reaper | bitwig
    "hostVersion": "15.0.30",
    "projectName": "26.9.6 lulabi",
    "bpm": 76.0,                  // 首拍速度 = tempoMap[0][1]；tempoMap 有完整曲线
    "timeSig": [4, 4],            // 首拍拍号
    "ppq": 480,                   // ticks per quarter note
    "sampleRate": 48000
  },
  "tempoMap":   [[tick, bpm], ...],          // 升序，首点 tick=0，阶梯语义（见下）
  "markers":    [[tick, "名字"], ...],
  "tracks":     [Track, ...],               // 自上而下的显示顺序
  "lengthTicks": 26240                       // 工程末尾（含最后一个事件 + 一小节余量）
}
```

### tempoMap 语义（v0.3 起是硬约定）

- **阶梯（hold / step）**：tick `t` 的速度 = 最后一个 `tick <= t` 的点的 `bpm`。
  两段之间**不做线性插值**。
- 首点必须是 `tick = 0`（工程开头就有速度）。
- 前端换算秒：把相邻点之间按"速度恒定"累加
  `dt_sec = (tick_{i+1} - tick_i) / ppq * 60 / bpm_i`。
- 宿主差异由**解析器**抹平，前端只认阶梯：
  - Cubase 速度轨本身就是阶梯（实测：事件间的实际 spq 恒等于前一个事件的 spq），
    一个变速点出一个点。
  - FL 的 Tempo 自动化曲线在点之间是**线性斜坡**，解析器把每段加密成
    一串台阶点（见 `flp_parser` docstring），前端不用知道 FL 的插值规则。
- 点数上限：解析器加密时控制粒度（FL 每 1/16 拍一个台阶），
  1129 点的 Cubase 轨原样输出。

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
  "controllers": [Controller, ...],  // 仅 midi；没有 CC 数据就是空数组
  "audioFile": "voc\\_lead.wav" // 仅 audio；解析器原样给出宿主里的路径
}
```

- `midi`：宿主里的"模式/部件"（Cubase 的 MIDI part、FL 的 Pattern），`notes` 相对片段起点。
- `audio`：音频片段（FL 的 Sampler/渲染音频通道），有 `audioFile`。
- `automation`：自动化片段（FL 的插件参数自动化）。**没有音频、也没有音符**，
  前端画成纯色块（不画假波形），底色用主题的 `--clip-auto`。
- `other`：宿主里存在、但类型没认出来的片段；前端用中性色渲染。

## Controller（v0.3，钢琴窗下部的自定义栏吃它）

```jsonc
{
  "cc": 11,                    // MIDI CC 号 0-127
  "name": "Expression",        // 常用 CC 给中文/英文名，其余 "CC<号>"
  "points": [[tick, value], ...]   // tick 相对 clip 起点（同 Note.startTick）；value 0-127，按 tick 升序
}
```

- 一个 clip 里同一个 CC 号只出现一次；没有 CC 数据的片段给 `[]`。
- **Cubase 与 REAPER 会填，FL 恒为 `[]`**：`.cpr` 的 MIDI 事件流里带真正的 CC
  （实测一份工程里 CC1 5271 点 / CC11 2715 点 / CC64 178 点）；REAPER 的 MIDI 事件流
  里带 `0xBn` 事件（一份工程实测每个 MIDI 片段末尾都有一条 CC123「全部音符关」，照收）；
  FL 的 `.flp` 不存 CC。
- 力度不需要控制器：`Note.velocity` 就是力度，前端直接画柱状。

## 宿主解析器

| 扩展名 | 模块 | 实测版本 |
|---|---|---|
| `.cpr` | `dawview/cpr_parser.py` | Cubase 15.0.30 / 15.0.21 WIN64 |
| `.flp` | `dawview/flp_parser.py` | FL Studio 25.2.4.5242 / 24.1.1.4285 |
| `.rpp` | `dawview/rpp_parser.py` | REAPER 7.67/win64 |
| `.bwproject` | `dawview/bwproject_parser.py` | Bitwig Studio 5.3.13 |

四种格式的**线格式（wire format）笔记写在各自解析器的 docstring 里**（都是实测逆向出来的：
字段偏移、事件 ID、踩过的坑），本文件只管两端之间的 JSON 契约。

FL 特有的几点（都会影响契约字段）：

- **速度**：FL 24+ 的 `.flp` 里有工程速度事件（ID 156，值 = BPM × 1000），
  再加上一条 **Tempo 自动化曲线**（内部控制器自动化通道的 ID 234 曲线，
  按播放列表里该通道的片段定位）。解析器把曲线的 0..1 值按
  `bpm = 60 + 120 × value` 还原（FL 速度自动化片段默认量程就是 60–180 BPM），
  再按 1/16 拍加密成阶梯点。老工程没有 156 事件时退回"音频片段时长反推"：
  拿音频片段的"源文件时长(ms) / 片段长度(tick)"当每 tick 毫秒数，
  众数 + 整数速度优先 → `bpm`（万古城.flp：557 个片段一致给出
  3.612717 ms/tick = 173.000 BPM）。
- **采样率不在文件里**：`sampleRate` 只能给默认 44100 并在 `warnings` 里说明。
- **没有 CC**：FL 的 Pattern 不存 MIDI CC，`controllers` 恒为 `[]`。
- 播放列表记录长度按版本不同（FL 25 是 80 字节，FL 24 是 60 字节，
  更早是 32 字节），解析器按"记录自洽"打分自动选。

REAPER 特有的几点（都会影响契约字段）：

- **RPP 是纯文本**，时间一律写**秒**（片段 `POSITION`/`LENGTH`/`SOFFS`、标记位置、
  速度轨点位置），契约只认 tick，所以解析器先拼出秒域的速度轨、再分段积分成 tick。
  定标判据（实测）：一个 `LENGTH 20.21052631578947` 秒的片段在 190 BPM 下正好
  64 个四分音符 = 61440 tick，而片段里 MIDI 事件的 tick 偏移累加也正好 61440。
- **ppq 960**（`HASDATA 1 960 QN`）。万一某个 MIDI 源的 ppq 不是 960，
  解析器按比例缩放到 960（契约的 `ppq` 对 REAPER 固定 960）。
- **速度轨**：工程速度在顶层 `TEMPO <bpm> <拍号分子> <拍号分母>`，
  变速在 `<TEMPOENVEX>` 的 `PT <秒> <bpm> ...`。REAPER 的速度轨本身就是阶梯
  （一个点保持到下一个点），与契约 v0.3 的语义天然一致，不用加密也不用插值。
- **文件夹轨**：`ISBUS` 第一个字段 = 1 是文件夹父轨 → 轨道 `kind: "folder"`；
  = 2 是"文件夹里最后一条轨"，它自己还是有内容的普通轨（按片段判 kind）。
- **乐器判定**：`<FXCHAIN>` 里插件描述前缀带 i（`VST3i:` / `VSTi:`）= 乐器 →
  有 MIDI 片段的轨道 kind 给 `instrument`，否则 `midi`。
- **标记**：顶层 `MARKER <序号> <秒> <名字> <标志位> ...`；区间是两行同序号的
  MARKER（第二行没有名字），只取第一行的起点当标记；标志位 &16（隐藏）的跳过。
- 降级：认不出的 `<SOURCE ...>`（比如 CLICK/REX）→ `kind: "other"` + warning；
  一个 item 只取第一个 take；`LOOP 1` 但源内容比片段短时**不复制**音符（记 warning）。

## Note

```jsonc
{
  "startTick": 240,            // 相对 clip 起点
  "lengthTick": 480,
  "pitch": 60,                 // MIDI note number 0-127
  "velocity": 100              // 1-127
}
```

Cubase 的力度取 note 记录里 pitch 后面那个字节（实测与 MIDI note-on 事件的
velocity 字节逐个吻合）；**不要用 `VffO`** —— 那个字段在一份 4313 音符的
工程里恒为 0.5，是力度压缩比之类的东西，不是力度。

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

## 取数通道（本地服务）

数据由 `dawview/server.py` 起的一个本地 HTTP 服务提供（纯标准库，只绑 `127.0.0.1`，
端口固定 `8973`）：

| 路径 | 说明 |
|---|---|
| `/index.html`、`/app.js` … | `web/` 下的静态文件，统一 `Cache-Control: no-store` |
| `/project.json` | 契约 JSON，**唯一数据入口**（直接来自内存，不读盘） |
| `/health` | 存活探针，返回当前连着的页面数 |
| `/events` | SSE 长连接：前端 boot 时连上，窗口一关就断 |

同一份 JSON 还会写进 `web/project.json`，所以不起服务、直接开页面也能看（无头验证走这条路）。

**关窗即退出**靠 `/events`：后端数着有几个页面连着，从"连过之后又归零"起算，稳定一小段
时间（扛住刷新）就退出。用 SSE 而不是"页面定时打心跳"，是因为后台标签页和 OBS 浏览器源里的
`setInterval` 会被浏览器节流（可慢到一分钟一次），心跳法会把"还在用"误判成"窗口关了"
而提前退出。`--keep-open` 可以关掉这个行为。

### 早期用 webui2 时踩的坑（记录备查，现在不依赖它了）

- 它的 `show()` / `show_browser()` 在本机失效：`browser_exist(Edge)` 直接抛访问违规，
  `show()` 返回 False 后连 HTTP 服务都会一起关掉（用户只看到空白窗口）。当时改成
  `start_server()` 只起服务，窗口自己用浏览器 app 模式拉。
- `show()` / `is_shown()` 的返回值都不可信；`webui.wait()` 不能用来保活（超时即返回、
  服务器随之消失），当时靠 `EventType.DISCONNECTED` 判断退出。
- 它每次启动随机挑端口，而浏览器把 `localStorage` 按"协议 + 主机 + 端口"隔离，
  用户调过的设置读不回来；当时用 `Window.set_port()` 钉住端口。现在端口自己定，没这问题。

## 显示选项不进契约

干净模式、片段名开关、跟随方式（翻页/居中）、行高（走带行高 / 钢琴窗半音行高）、
视图模式（走带/钢琴窗）、播放速度、动效（开关与强度/余韵）、**哪些轨道显示/隐藏**、
**每条轨道的颜色**、**钢琴窗下部的力度/CC 栏（有几栏、每栏看哪个 CC、栏高）**、配色 ——
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
