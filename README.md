# dawview

用更优雅的方式展示工程。

dawview 把 DAW 工程文件解析成一条可以滚动浏览的时间轴。工程里的轨道、片段、MIDI 音符、
力度与 CC 曲线、速度变化和音频片段的摆放位置，都在同一套时间基准上呈现：走带视图看结构，
钢琴窗看音符；时间换算跟着工程自己的 ppq 与速度轨走，画面上的位置、长度、速度读数与
工程里一致。录走带演示、讲编曲结构，或者只是回看一份工程，都用得上。

![走带视图](docs/screenshot-arrange.png)

后端是纯 Python（只用标准库），前端是原生 JS（无构建、无 npm），没有第三方依赖，
也不需要 `pip install`。窗口用系统自带的 Edge / Chrome 以 app 模式打开。

## 支持格式

| 宿主 | 扩展名 | 实测版本 | 解析器 |
|---|---|---|---|
| Cubase | `.cpr` | 15.0.30 / 15.0.21 WIN64 | `dawview/cpr_parser.py` |
| FL Studio | `.flp` | 25.2.4.5242 / 24.1.1.4285 | `dawview/flp_parser.py` |
| REAPER | `.rpp` | 7.67/win64 | `dawview/rpp_parser.py` |
| Bitwig Studio | `.bwproject` | 5.3.13 | `dawview/bwproject_parser.py` |
| Studio One | `.song` | 7.1.0.104182 | `dawview/song_parser.py` |
| 标准 MIDI 文件 | `.mid` / `.midi` | SMF 格式 0 / 1 / 2 | `dawview/midi_parser.py` |
| dawview 契约 JSON | `.json` | — | 直接打开（内置示例走这条） |

六种工程格式的线格式笔记（字段偏移、事件 ID、单位规则、实测样本）写在各自解析器的
docstring 里，可以单独阅读。新增宿主只需在 `dawview/app.py` 的 `PARSERS` 里登记一个
"路径 → 契约字典"的函数。

## 功能

| 功能 | 说明 |
|---|---|
| 走带视图 | 轨道、片段、音符、标尺与网格；横向滚动、时间缩放、行高缩放 |
| 钢琴窗 | 时间 × 音高，纵轴是全部 128 个琴键，左侧键栏标音名；进入视图自动滚到音符所在音区 |
| 变速播放 | 按工程速度轨逐段变速走带，顶栏实时显示当前位置的速度 |
| 播放动效 | 音符闪光、片段入点光晕、播放头拖尾；分别开关，强度分档 |
| 力度 / CC 曲线栏 | 钢琴窗下部可加多条曲线栏，分别看力度或工程里任意一种 CC，栏高可调 |
| 主题 | 12 套（深色 7 / 浅色 5），对比度有硬性门槛，验证脚本逐套核对 |
| 轨道配色 | 每轨单独配色（12 色卡 / 自定义取色 / 批量渐变），按工程分别记忆 |
| 轨道选择器 | 显示隐藏、按种类快筛、渐变上色；走带与钢琴窗一处生效 |
| 用户音频轨 | 导入自己的音频、摆位置、裁长短，跟走带同步播放 |
| 干净模式 / 导出模式 | 一键隐藏界面元素，分别用于录屏与叠层底图 |
| 多窗口联动 | app 窗口与 OBS 浏览器源共享设置、同步操作与播放位置 |

### 解析内容

- **轨道**：名字、显示顺序、种类（乐器 / MIDI / 音频 / 文件夹 / 总线 / 自动化 / 标记 / 速度 / 其他）
- **片段**：种类（MIDI / 音频 / 自动化 / 其他）、位置、长度、名字；音频片段带宿主里记录的素材路径
- **MIDI 音符**：音高、起始、长度、力度（力度逐音符绘制成柱状）
- **CC 曲线**：按 CC 号归组进片段，钢琴窗下部的曲线栏直接取用
- **速度轨**：完整的变速曲线，阶梯语义（一个速度点保持到下一个点），播放与时间换算都以它为准
- **拍号、标记、采样率**：进工程信息栏；文件里没有的项（如 FL 的采样率）取默认值并记进 `warnings`

## 快速开始

### 环境

- Python 3.10+（代码里用了 `X | Y` 类型标注）
- 浏览器：Windows 10/11 自带 Edge，直接可用；没有 Edge / Chrome 时退回系统默认浏览器
- 不需要安装任何第三方包

想连 Python 都不装时，把 python.org 的 `python-3.11.x-embed-amd64.zip` 解压到仓库根目录的
`python-embed/`，`run.bat` 会优先使用它（`python-embed/` 不入库）。

### 运行方式

| 方式 | 命令 |
|---|---|
| Windows 双击 | `run.bat`（默认打开内置示例；想固定打开自己的工程，把路径写进 `default-project.txt`） |
| 拖放 | 把工程文件拖到 `run.bat` 上，或直接拖进 dawview 窗口 |
| 命令行 | `python -m dawview "路径/工程.flp"` |
| 先看看长什么样 | `python -m dawview docs/demo-project.json` |
| 只看解析结果、不起服务 | 加 `--dev`（写出 `web/project.json`） |
| 不起窗口、只起服务 | 加 `--no-window`（打印服务地址，给 OBS 或外部浏览器用） |
| 页面关掉后服务保留 | 加 `--keep-open`（Ctrl+C 结束） |
| 指定外观设置落盘位置 | 加 `--prefs 路径`（默认 `web/prefs.json`；`--prefs none` 只在内存里同步） |

窗口关掉时程序自动退出，不留后台进程；OBS 浏览器源仍连着时，服务会等它断开。

### 快捷键

| 按键 | 效果 |
|---|---|
| 滚轮 / Shift+滚轮 | 上下浏览轨道 / 横向滚动时间线 |
| Ctrl+滚轮 / Alt+滚轮 | 时间缩放（锚定鼠标位置）/ 行高缩放 |
| 点标尺、点时间线 | 定位播放头 |
| 空格 / `Home` | 开始或暂停走带播放 / 回到开头 |
| `M` | 走带视图 ↔ 钢琴窗 |
| `,` | 打开或关闭设置菜单 |
| `T` | 轨道选择器（同顶栏「轨道 ▾」） |
| `I` | 导入音频到用户音频轨（同顶栏「＋ 音频」） |
| `H` / `Esc` | 干净模式（`H` 切换，`Esc` 退出） |
| `E` | 导出模式 |
| 点轨道头右侧色卡 | 给这条轨道单独配色（右键恢复默认色） |
| 拖音频片段中间 / 两端 | 挪位置（按住 `Alt` 临时不吸附）/ 裁长度 |
| 右键音频片段 / 音频轨头 | 删这一段 / 删这条音频轨 |

### 设置菜单

点顶栏「设置」或按 `,` 打开，左侧分组、右侧选项：

| 分组 | 选项 |
|---|---|
| 显示 | 干净模式、导出模式、片段上显示名称、轨道头 / 钢琴键栏、走带行高、钢琴窗半音行高 |
| 视图 | 视图模式（走带 / 钢琴窗）、播放跟随（翻页 / 居中） |
| 播放 | 播放速度（0.5x / 1x / 1.5x / 2x） |
| 控制器 | 力度栏、CC 曲线栏、单栏高度 |
| 音频 | 导入音频、音频轨、拖动吸附到拍、播放音频、显示音频区、存放位置 |
| 动效 | 启用播放动效、音符闪光、片段入点光晕、播放头拖尾、强度、余韵 |
| 配色 | 主题（深色 7 套 / 浅色 5 套）、主色 |

显示选项（主题、配色、隐藏了哪些轨道、行高、动效、缩放、播放速度）只存 `localStorage`，
下次打开仍是这套。因此服务端口固定为 `8973`（可用环境变量 `DAWVIEW_PORT` 覆盖）：
浏览器按"协议 + 主机 + 端口"隔离 `localStorage`，端口一变设置就读不回来；
端口被占用时退回随机端口并明确提示。

### 轨道选择器

左上角「轨道 ▾」或按 `T` 打开。取消勾选的轨道在走带里不画这一行、钢琴窗里也不画这一轨的
音符；面板顶部显示"显示 N / N 条轨道"与「全选 / 全不选」，状态栏标出隐藏了几条。
每行前面的色点就是这条轨道当前的颜色。

- **按种类快筛**：顶部一排胶囊（`全部 / MIDI / 音频 / 自动化 / 乐器 / 其他 …`），只列出
  这个工程里实际存在的种类并附带条数；点一下只留这一类，点「全部」恢复。它走同一套隐藏机制，
  所以钢琴窗、状态栏与记住的显示状态一并跟随；手动勾选会自动取消胶囊的选中态。
- **渐变上色**：面板底部一排按钮，给当前显示的轨道按从上到下的顺序排一条渐变：沿色卡
  调色板插值（按色相排序后插值，饱和度压到 0.5 以内），或沿色相环扫 300°（深色主题
  S 0.42 / L 0.62，浅色主题 S 0.34 / L 0.42），另有「清除」恢复跟随主题。先按种类筛出
  MIDI 轨再点渐变，就是只给 MIDI 轨上色。
- 轨道栏被关掉（干净模式或设置里关掉轨道头）时，选择器自动收起。

### 轨道颜色

轨道头右侧的色卡按钮点开是配色面板：12 个预设色卡、自定义取色器（原生取色）、
「默认」按钮；右键色卡即恢复默认色。选中的颜色用在轨道头的色条与色卡、走带里这条轨的
片段（底色 / 边框 / 波形柱）与片段内音符、钢琴窗里这一轨的音符。

颜色按工程分开记在 `localStorage`（`dawview.trackColors`，键是工程名 + 轨道序号），
换工程不串色。

### 主题

设置 → 配色 → 主题，按深色 / 浅色分两组，共 12 套：

- 深色：水蓝、深夜、深海、霓虹、苔原、落日、摩卡
- 浅色：晨雾、象牙、薄荷、樱花、青灰

一套主题就是一组 CSS 变量（底色 / 面板 / 边线 / 网格 / 正文 / 次要文字 / 主色 /
三种片段色 / 音符色）。画布也从这些变量取色，所以换主题是全站生效：走带、钢琴窗、
轨道头、菜单、状态栏一起变；「主色」可以单独覆盖主题的主色。

新增主题只改 `web/theme.js`：照已有条目复制一份，写 `kind`（`'dark'` / `'light'`）、
`label` 和全部变量，菜单分组自动跟上。对比度要求写在文件头注释里，`scripts/verify.mjs`
会逐套核对：变量齐全、页面取值与主题定义一致、对比度达标、深浅标记与底色亮度相符、
三种片段色两两可分。

### 钢琴窗与曲线栏

设置 → 视图 → 视图模式选「钢琴窗」：横轴时间、纵轴音高，左侧钢琴键栏标音名（C4 = 中央 C），
纵向是全部 128 个琴键，靠滚动浏览；进入视图时自动把视野滚到音符所在音区。轨道多时按轨道在
音符色与主色之间取中间色区分。音符滚出左边界即被裁掉，不会叠在键栏上。

![钢琴窗](docs/screenshot-piano.png)

设置 → 控制器：勾「力度栏」加一条力度柱状栏，「CC 曲线栏」可加多条，每栏一个下拉选择
这个工程实际存在的 CC（下拉里标了 CC 号与点数）；栏高可调，栏名写在每栏左上角，
默认一栏都不显示。

![力度 / CC 栏](docs/screenshot-lanes.png)

- 力度柱高 = `notes[].velocity / 127`；CC 按阶梯折线绘制（CC 是保持值而非斜坡，
  踏板一类 0 / 127 的曲线这样最清楚），中线 64 便于读图。
- 曲线栏跟随横向滚动与缩放，播放头从栏上穿过；音符区自动让出栏占的高度。
- 这几栏属于显示偏好（有几栏、每栏看哪个 CC、栏高），只存 `localStorage` 的
  `dawview.view`，不进数据契约。

### 变速播放

走带播放跟随工程的速度轨：曲子里速度变化多少次，播放头的推进速率就跟着变多少次，
时间换算（tick ↔ 秒）也走同一条曲线。顶栏走带标签显示当前位置的速度
（`小节.拍.tick · 速度 BPM`）。

| 宿主 | 速度来源 |
|---|---|
| Cubase | `MTempoTrackEvent` 之后的定长记录表（实测 1129 条记录 → 1127 个变速点），阶梯语义 |
| FL Studio | 工程速度事件（`ID 156`，值 = BPM × 1000）+ Tempo 自动化曲线（`ID 234`，按 1/16 拍加密成台阶） |
| REAPER | 顶层 `TEMPO` 行 + `<TEMPOENVEX>` 的 `PT <秒> <bpm>` 点（本身就是阶梯） |
| Bitwig | 工程 `TEMPO` 字段（恒定速度） |
| Studio One | `TempoMapSegment`（速度图，与 `metainfo` 的 `Media:Tempo` 吻合） |
| MIDI | `0x51` 速度事件（三字节微秒数），实测一份 MuseScore 导出有 216 个点 |

契约里的 `tempoMap` 是 `[[tick, bpm], ...]`，前端按阶梯逐段积分钟数；没有速度信息的工程
退化成单点（按 `meta.bpm` 定速）。

### 用户音频轨

想在自己的工程画面上叠一条参照音频（扒带、对拍、给录屏配讲解音）时用它：顶栏「＋ 音频」
或按 `I` 选文件，也可以把音频文件直接拖进窗口。走带最上方会出现音频轨区，可以在里面
摆位置、裁长短，播放时跟着走带一起出声。

- **格式**：`.mp3 / .wav / .ogg / .opus / .flac / .m4a / .aac / .aif` 等浏览器能解码的格式，
  单个文件上限 1 GB；解不开的编码会明确提示。
- **导入**：拖到空音频区为每个文件新建一条音频轨，拖到已有音频轨那一行为放进该轨。
  素材由后端接收并保存（`POST /media` 上传、`GET /media/<名字>` 取回，支持 Range 分段读），
  所以刷新页面、换窗口都还在。
- **摆位置 / 裁长短**：拖片段中间挪位置，拖左右两端改长度（左端裁掉的是"从源文件第几秒
  开始取"，内容在时间轴上不会跳）；拖动时片段下沿显示读数（`小节.拍 · +秒 · 取 a–b 秒`），
  按住 `Alt` 临时不吸附。
- **吸附**：默认吸到拍（跟工程 ppq 走），「设置 → 音频 → 拖动吸附到拍」可关闭。
- **播放**：跟着走带出声，按播放速度变速（0.5x–2x，磁带式）；从片段中间起播时自动从源文件
  对应位置接着放。每条音频轨可单独静音（轨道头上的 `M`），「设置 → 音频 → 播放音频」可
  整体关闭。用 OBS 录制时按下一节设置「通过 OBS 控制音频」。
- **删除**：右键片段删这一段（该轨空了则整轨收掉），右键轨道头删整条轨；素材文件仍留在
  磁盘上，重复导入不会重复占用空间。
- **存放位置**：音频数据与素材存在工程文件旁边的 `.dawview/`（`audio-lanes.json` + `media/`），
  跟着工程走；目录不可写时只在本次会话里有效并明确提示。多窗口之间经 `/audiolanes` 同步。
- 直接打开 `index.html`（没跑后端）时音频区不可用，其余功能照常。

### 播放动效

播放时播放头扫过的内容会亮起：音符提亮并带外发光，片段入点整块亮起并有一道流光，
播放头后面拖一段渐隐拖尾。全部可在「设置 → 动效」里分别开关，强度分柔和 / 标准 / 强烈，
余韵决定拖尾长度。

播放头这一层只画在时间线内容区，拖尾向左延伸时会被裁掉，不会盖到轨道头上。

![干净模式 + 导出模式：只剩内容，拿去叠层编辑](docs/screenshot-export.png)

### 用 OBS 浏览器源录制

1. **打开 dawview**：把工程文件拖到 `run.bat` 上，或在命令行运行
   `python -m dawview "工程.flp"`。窗口打开的同时，命令行会打印 OBS 要填的地址：

   ```
   [dawview] 服务已启动：http://localhost:8973/index.html
   [dawview] OBS 浏览器源填这个地址（外观 / 操作都跟着 app 窗口走）：http://localhost:8973/index.html
   ```

2. **在 OBS 里加「浏览器」源**：URL 填上面那行地址，宽高按需要的画面设置（例如 1920×1080）。
   - 勾上「通过 OBS 控制音频」（浏览器源属性里的 *Control audio via OBS*），页面里
     用户音频轨的声音就由 OBS 接管、进入混音器。
   - 填**不带** `?role=host` 的那行地址：`?role=host` 是 dawview 窗口专用的"设置以我为准"
     标记，浏览器源带上会与主窗口争设置。
   - 只给 OBS 当画面、不需要 dawview 窗口时，用 `--no-window` 起服务。
3. **在 dawview 窗口里调画面**：主题、轨道配色、缩放、行高、视图模式、干净模式或导出模式；
   OBS 画面跟着变，不需要在 OBS 里重调。
4. **操作也在 dawview 窗口里做**：空格播放或暂停、点标尺定位，OBS 画面同步跟随。
5. **声音只走浏览器源那一路**：页面本身不合成工程里的 MIDI 与音频片段，只有用户音频轨会
   跟着走带播放。OBS 混音器里把「桌面音频」静音、只留浏览器源，避免同一份声音进两路；
   需要别的配乐时在 OBS 里另加音频源。
6. **开始录制**。

端口固定为 `8973`，OBS 里配置一次即可长期使用。

app 窗口与 OBS 浏览器源之间是联动的（浏览器源是 OBS 自己一套浏览器实例，
`localStorage` 不通用，所以走服务端中转）：

| 效果 | 实现 |
|---|---|
| 浏览器源的外观与 dawview 窗口一致（主题 / 显示选项 / 轨道配色 / 缩放） | 设置存在服务端共享副本（`/prefs`，落盘到 `web/prefs.json`）；`?role=host` 窗口以自己的设置为准并推送，浏览器源启动时拉取、运行中收到广播即跟随 |
| 在 dawview 窗口里的操作，OBS 画面跟着播 | 操作走 `/control` 中继：播放 / 暂停、定位、缩放、行高、视图切换、干净 / 导出模式、轨道显示隐藏都会广播给其它窗口执行 |
| 播放中两边画面不飘 | 最近被操作的窗口作为时钟主，每 250ms 报一次位置，其它窗口偏差约 12px 时纠正 |
| 用户音频轨两边一致（位置 / 裁剪 / 静音） | 存盘后经 `/audiolanes` 广播，各窗口重新排一次播放 |
| 用按键或外部工具驱动 | `curl -d '{"action":"toggleplay"}' http://localhost:8973/control`；动作白名单见 `dawview/server.py` 的 `CONTROL_ACTIONS` |

## 宿主解析要点

每个解析器的完整线格式笔记在文件 docstring 里，这里只列影响画面结果的要点与实测样本。

### Cubase（.cpr）

二进制工程流。实测 `Orchestra practice 1-03.cpr`（63 MB / Cubase 15.0.21）解析结果：
115.0 BPM / 3-4 / ppq 480 / 54 条轨道 / 28 个 MIDI 片段 / 4693 个音符 / 速度轨 1127 点。

- 速度轨是 `MTempoTrackEvent` 之后的定长记录表（22 字节一条：每四分音符秒数 + 绝对秒 +
  绝对 tick + 标志），阶梯语义，相邻两点的实际间隔恒等于前一点的每四分音符秒数。
- 音符记录是"位置（f64 tick）+ 音高 + 力度"三字节，长度写在紧随其后的 `TDRH` 属性里，
  单位是四分音符；`VffO` 字段恒为常数，不参与力度计算。
- CC 在 `yTuc` 记录里（状态 `0xB0`）：实测这份工程 CC1 5271 点、CC11 2715 点、CC64 178 点。
- 音符与 CC 记录在文件里是分散存放的（同一 tick 空间，不按字节区间分块），归轨按时间判断。

### FL Studio（.flp）

二进制事件流（`FLhd` + `FLdt`）。实测 `piano practice 7.flp`（FL Studio 24.1.1.4285）
解析结果：135.0 BPM / 4-4 / ppq 96 / 2 条轨道（MIDI + 自动化）/ 4 个片段 /
2708 个音符 / 速度轨 897 点。

- 播放列表记录长度随版本变化（FL 25 为 80 字节、24.1 为 60 字节、更早为 32 字节），
  解析器按记录自洽程度自动选择，新旧工程都能读。
- 模式片段带裁剪区间：记录里 `@24` 的两个 u32 表示"播放模式中的哪一段"，音符按区间裁剪后
  再摆放，同一个模式被切成多段时不重复计入。
- 速度：FL 24+ 有工程速度事件与 Tempo 自动化曲线（曲线值按 `BPM = 60 + 120 × value` 还原，
  这份工程的 897 个台阶点就是曲线加密来的）；更早的工程没有速度事件，按音频片段的
  "源文件时长 / 片段长度"反推。
- 自动化片段单列一类，用独立主题色平涂，轨道标签为「自动化」。
- 轨道表固定写满 500 条，只输出有内容或有名字的轨道。

### REAPER（.rpp）

纯文本分块工程（`<TAG ...>` 开块、`>` 收块）。实测 `dnb.rpp`（REAPER 7.67/win64）
解析结果：190.0 BPM / 4-4 / ppq 960 / 19 条轨道（3 条文件夹轨、6 条乐器轨、2 条 MIDI 轨、
8 条音频轨）/ 266 个片段（音频 253 + MIDI 13）/ 393 个音符。

- 文件里的时间全是秒（片段位置与长度、标记位置、速度点），解析器先在秒域拼出阶梯速度轨，
  再分段积分成 tick。定标依据：`LENGTH 20.21052631578947` 秒的片段在 190 BPM 下正好是
  64 个四分音符 = 61440 tick，与该片段内 MIDI 事件的 tick 偏移累加一致。
- MIDI 事件写作 `E <相对偏移> <状态字节 d1 d2>`，偏移是增量；行首 `e` 与 `E` 分别表示
  未选中与选中，两者都是事件（`E 0 90 28 60` 是音高 40、力度 96 的 note-on）。
- CC 就在事件流里（`0xBn`），钢琴窗的曲线栏对 REAPER 工程有效（每个 MIDI 源末尾的
  CC123「全部音符关」也在其中）。
- 文件夹父轨按 `ISBUS` 第一个字段判定；乐器按 FX 链插件描述前缀判定（`VST3i:` / `VSTi:`）。
- ppq 固定 960。

### Bitwig Studio（.bwproject）

二进制容器加一个元素流文档，结构化摘要（工程名 / 轨道名 / 种类）嵌在容器的 meta 块里。
实测 `25.6.30 house.bwproject`（Bitwig 5.3.13）解析结果：124.0 BPM / ppq 480 /
31 条轨道（11 乐器 + 16 音频 + 4 总线）/ 592 个片段（MIDI 44 + 音频 548）/ 2363 个音符。
片段数远多于轨道数，因为 8 小节循环被复制粘贴了许多遍，每一遍在文件里都是独立的片段对象。

- 元素头 15 字节，同一份文件里另有更紧凑的写法（复制出来的片段用的是紧凑写法），
  解析器按"位置字段 `0x2af` 固定在元素头 +15""轨道元素 `00 00 18 cb 12`"等锚点定位元素。
- 字段格式是 `[u32 字段号][u8 tag][值]`：`0x07` = f64，`0x08` = UTF-8 字符串，
  `0x09` = u32，`0x11` / `0x01` = u8；位置、长度、力度在文件里都是拍，乘 480 换 tick。
- 音高写在"音高轨"的 footer 上，音高轨按音高降序排列，某个音符的音高取排在它后面最近的
  那个 footer。
- 片段归轨按"轨道片段列表头"对齐：MIDI 组对应乐器轨，音频组对应混合轨。
- 音符位置是 pattern 坐标，显示位置 = 片段起点 +（音符位置 − 内容窗口起点）。
- 音频片段名只在每组第一段的样本记录里出现，解析器向前补齐。

### Studio One（.song）

`.song` 是 ZIP：`metainfo.xml`（标题 / 版本 / 速度 / 采样率）、`Song/song.xml`（走带与全部
轨道事件）、`Song/mediapool.xml`（`mediaID` → 文件路径）、`Devices/*.xml`（乐器通道 / 混音台）、
`Performances/<乐器>/<名>(n).musicx`（音符在二进制演奏文件里）。实测
`2025-08-29 39610.song`（Studio One 7.1.0.104182）解析结果：162.0 BPM / 4-4 / 48000 Hz /
ppq 480 / 62 条轨道（39 音频 + 17 乐器 + 1 MIDI + 5 总线）/ 2040 个片段
（MIDI 98 + 音频 1942）/ 11530 个音符。

- 位置单位跟轨道 `tempoFollow` 走（`0` = 秒、`2` = 拍），长度单位跟事件 `timeFormat` 走
  （`0` = 秒、`2` = 拍），两套单位在同一份工程里分别决定。
- 片段是窗口：`MusicPart.offset` 是片段左缘对应的源位置，音符显示位置 = 片段起点 +
  （音符位置 − offset）；窗口之外的音符裁到边界。
- 演奏文件里的力度是 0..1 的浮点数，乘 127 进契约；`quantize.*` 记录的是改动前的值，
  不参与计算。
- 乐器判定看 `Devices/musictrackdevice.xml` 里的通道有没有 `instrumentOut` 连接。
- 分层轨（`layerCount`）的事件在各层里，全部收下。
- XML 里的 `x:` 前缀没有 `xmlns` 声明，解析器补齐声明后交给标准库解析。

### 标准 MIDI 文件（.mid）

二进制块流：`MThd`（格式号 / 块数 / division）+ 若干 `MTrk`；事件 = 变长量 delta +
状态字节 + 数据字节，状态字节可以省略、沿用上一条（运行状态）。实测
`Spring Mpnody.mid`（MuseScore 导出，格式 1 / ppq 480）解析结果：136.0 BPM / 4-4 /
39 条 MTrk（33 条内容轨 + 5 条空轨 + 1 条走带块）/ 5346 个音符 / 216 个速度点 / 3 分 41 秒。

- 文件里没有片段这一层，映射为"一条 MTrk 一条轨道、整条轨一个片段"（起点 0、长度到该轨
  内容末尾）；格式 0 按通道拆成多条轨道（`轨名 · 通道 N`）。
- 只带速度 / 拍号 / 轨名的走带块不显示为轨道；有名字但没有音符的轨道保留为空行
  （编制里有这件乐器、这一段没有演奏）。
- 音符按 `(通道, 音高)` 先入先出配对；力度 0 的 note-on 视为 note-off；没写 note-off 的
  音符按该轨结束 tick 补齐。
- 速度点写在 `0x51` 事件里（三字节微秒数），反算出的 BPM 收敛到 1e-3；
  内容末尾之后很远的速度点会被忽略（MuseScore 会在这样的 tick 上多写一条）。
- CC 在事件流里（`0xBn`）：实测 7 种，CC1 调制轮 15911 点最多。
- SMPTE 计时的文件（division 高位置 1）按标称速度重标到 480 ppq 网格，秒数保持一致。

## 数据契约

后端解析成契约 JSON，由本地 HTTP 服务（`dawview/server.py`）发给前端；同一份 JSON 也写进
`web/project.json`，因此不起服务、直接打开页面也能看（无头验证走这条路）。契约是两端唯一
接口，写在 [`docs/01-data-contract.md`](docs/01-data-contract.md)：顶层
`meta / tempoMap / markers / tracks / lengthTicks`，轨道有 `kind`（`instrument` / `midi` /
`audio` / `folder` / `bus` / `automation` / `marker` / `tempo` / `other`），片段有 `kind`
（`midi` / `audio` / `automation` / `other`）、`notes`（含 `velocity`）与 `controllers`
（`{cc, name, points: [[tick, value], ...]}`，tick 相对片段起点）；`tempoMap` 是
`[[tick, bpm], ...]` 的阶梯速度轨（首点必在 tick 0）。

三条铁律：tick 是唯一时间单位，前端用 `ppq` 与 `tempoMap` 换算秒；`startTick` 是绝对时间，
`Note.startTick` 相对片段；单个轨道或片段解析失败只跳过它并记 `warning`，其余照常显示。

显示选项不进契约：主题、颜色、隐藏了哪些轨道、行高、动效只存 `localStorage`，不回传后端。

## 项目结构

```
dawview/          纯 Python 后端
  cpr_parser.py   Cubase .cpr 解析器（二进制工程流，含格式注释）
  flp_parser.py   FL Studio .flp 解析器（事件流 + 播放列表记录，80/60/32 字节自适应）
  rpp_parser.py   REAPER .rpp 解析器（纯文本块 + 秒/tick 换算，含格式注释）
  bwproject_parser.py  Bitwig .bwproject 解析器（容器 + 元素流，含格式注释）
  song_parser.py  Studio One .song 解析器（ZIP + XML 走带 + 二进制演奏文件，含格式注释）
  midi_parser.py  标准 MIDI .mid 解析器（变长量 delta + 运行状态 + meta 事件，含格式注释）
  model.py        宿主无关数据模型
  audiolanes.py   用户音频轨：可写数据 + 本地媒体库（纯标准库，不进契约）
  server.py       本地 HTTP 服务（静态文件 + /project.json + /audiolanes + /media + /events）
  app.py          入口：解析 → 起本地服务 → 开窗口（PARSERS 按扩展名分发）
web/              前端（原生 JS，无构建）
  timeline.js     Canvas 绘制（走带 / 钢琴窗 / 用户音频轨）
  app.js          状态、交互、轨道配色、主题切换、音频轨的拖 / 裁 / 存
  audio.js        用户音频轨：纯逻辑（tick ↔ 秒、裁剪、吸附、播放排期、峰值）+ Web Audio
  theme.js        12 套主题定义
docs/
  01-data-contract.md   前后端唯一接口（改契约必须两端同步）
  demo-project.json     手写的合成示例工程（run.bat 默认打开）
tests/            pytest（161 项：Cubase 6 + FL 10 + REAPER 21 + Bitwig 7 + Studio One 20 + MIDI 15 + 速度轨/力度/CC 16 + 本地服务/多窗口 41 + 音频轨 25）
scripts/
  verify.mjs       前端 CDP 验证（38 + 10 + 6 + 6 + 8 + 7 + 5 项，见下）
  audio-verify.mjs 用户音频轨端到端验证（自起服务 + 自起浏览器，45 项）
  relay-verify.mjs 多窗口联动端到端验证（自起服务 + 两个浏览器实例，35 项）
  fx-probe.mjs     动效可见度量化（像素级差分）
  make-demo.py     重新生成 docs/demo-project.json
  make-fixture.py  从工程文件裁一份验证快照（快照不入库，见下）
  smoke_window.py  冒烟测试：真窗口能否打开（起服务 + 拉窗口，打印地址）
run.bat            Windows 启动器
```

用户音频轨的数据与素材存在工程文件旁边的 `.dawview/`（`audio-lanes.json` + `media/`），
跟着工程走、不进仓库（`.gitignore` 已忽略）。

## 验证

```bash
python -m pytest tests/ -q                       # 161 项
```

解析器与本地服务不需要浏览器即可验证：

- `tests/test_server.py`（41 项）覆盖本地服务本身：路由、`/project.json`、`/prefs` 共享设置、
  `/control` 中继、SSE 客户端计数、关窗判定、请求体上限、`../` 越界访问。
- `tests/test_audiolanes.py`（25 项）覆盖用户音频轨后端：数据收窄、落盘与读回、上传去重、
  Range 取音频、路径越界、上传超限、跨窗口广播。
- 每个宿主解析器各有一份测试，分两段：按线格式手搓的最小合成工程（总能跑）与真实工程
  （文件在才跑，断言实测值）。

前端验证需要一个静态服务与一个带 CDP 的浏览器：

```bash
python -m http.server 8765 --bind 127.0.0.1 --directory web &
"C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe" \
  --headless=new --remote-debugging-port=9223 \
  --user-data-dir=$LOCALAPPDATA/Temp/edge-cdp-dawview &
node scripts/verify.mjs                          # 前端 80 项（Cubase 38 + FL 10 + REAPER 6 + Bitwig 6 + Studio One 8 + MIDI 7 + 变速 5）
node scripts/fx-probe.mjs                        # 动效可见度量化（像素级差分）
```

用户音频轨要验的是"上传 → 落盘 → 读回解码 → 摆位置或裁长短 → 出声 → 存盘重载"整条链路，
而 `verify.mjs` 挂的是静态服务（没有那些接口），所以单独一个脚本，它自带本地服务与无头浏览器，
工程与音频都放临时目录、跑完删除：

```bash
node scripts/audio-verify.mjs                    # 45 项
node scripts/audio-verify.mjs docs/demo-project.json --python py
```

多窗口联动（app 窗口 + OBS 浏览器源）同样是端到端脚本，自带服务与两个浏览器实例
（各自的 `user-data-dir`，`localStorage` 不通用才算数）：

```bash
node scripts/relay-verify.mjs                    # 35 项：设置共享 / 操作中继 / 播放位置校准
node scripts/relay-verify.mjs "工程.flp"          # 换一份工程跑
```

`verify.mjs` 用的数据快照不进仓库（里面有真实工程的工程名与轨道名），自己生成一份即可，
文件名按扩展名固定：

```bash
python scripts/make-fixture.py "我的工程.cpr"       # -> scripts/fixture-project.json
python scripts/make-fixture.py "我的工程.flp"       # -> scripts/fixture-project-fl.json
python scripts/make-fixture.py "我的工程.rpp"       # -> scripts/fixture-project-reaper.json
python scripts/make-fixture.py "我的工程.bwproject" # -> scripts/fixture-project-bitwig.json
python scripts/make-fixture.py "我的工程.song"      # -> scripts/fixture-project-studioone.json
python scripts/make-fixture.py "我的工程.mid"       # -> scripts/fixture-project-midi.json

# 变速那 5 项需要一份真的带变速的工程快照（.cpr / .flp 都行），单独一个开关：
python scripts/make-fixture.py "变速工程.cpr" --out scripts/fixture-project-tempo.json
node scripts/verify.mjs --tempo-fixture scripts/fixture-project-tempo.json
```

没有对应快照时脚本跳过那一段并明确说明，不会产生假失败。

验证脚本本身的几条约定：

- 关掉浏览器缓存（`Network.setCacheDisabled`），否则改过 `web/*.js` 后测到的是旧文件。
- 断言使用真鼠标与键盘事件（CDP `Input.dispatchMouseEvent`）：`dispatchEvent` 只能验证
  处理函数绑没绑上，验证不了点击是否真的落在目标上。
- 新增的绘制类断言都做过反向验证：把修复临时改回旧写法，对应检查必须失败，改回来才全绿。
- 半透明像素断言与混合后的颜色比对（`0.84 × 底色 + 0.16 × 片段色`）。
- 共享的 headless 浏览器上先 `Page.bringToFront`：页面处于后台时 rAF 被节流，播放头不推进、
  截图不返回，断言会得出错误结论。
- 涉及缩放的断言先把 `pxPerTick` 钉住再测。
- 截图产物在 `.cache/shots/shot-*.png`（`--shot-dir <目录>` 可改）。

想确认这台机器上真窗口能起来，跑 `python scripts/smoke_window.py "工程.cpr"` 冒烟。

## 致谢

- FLP 格式参考了 [PyFLP](https://github.com/demberto/PyFLP) 的源码（只作为资料阅读，没有依赖）
- REAPER 的 `.rpp` 字段语义参照 ReaTeam/Doc 的
  [State Chunk Definitions](https://github.com/ReaTeam/Doc)，单位（秒 / ppq / 十六进制事件字节）
  都用工程文件本身交叉验证过
- 窗口用 Edge / Chrome 的 app 模式（`--app=`），本地服务用标准库 `http.server`
