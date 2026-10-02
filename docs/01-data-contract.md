# dawview 数据契约 (v0.7)

> 解析器（Python 后端）与 WebUI 前端之间的唯一接口。
> 改契约 = 改这个文件头部 changelog + 两端同步。
> 方向：后端 → 前端单向推送（`loadProject`），前端不回传数据。
>
> 注：**用户自己导入的音频轨（AudioLane）不在本契约里**。那是"用户素材 + 界面上的改动"，
> 必须能回写，和这份只读契约方向相反 —— 所以单开了一条可写通道
> （`GET /audiolanes.json` / `POST /audiolanes` / `POST /media` / `GET /media/<名字>`，
> 实现见 `dawview/audiolanes.py`，用法见 README「用户音频轨」一节）。
> 本文件只描述"从工程文件解析出来的只读数据"。

## Changelog
- v0.7 (2026-10-02): 支持标准 MIDI 文件 `.mid` / `.midi`（SMF 格式 0 / 1 / 2）。
  `host` 加 `midi`；`ppq` 用文件头里的 division（SMPTE 计时的文件重标到 480 ppq）。
  **MIDI 里没有"片段"这一层**，映射定为「一条 MTrk = 一条轨道、整条轨一个片段」
  （起点 0、长度到该轨内容末尾）—— 和 Cubase / Studio One 导入 MIDI 的习惯一致；
  格式 0（所有通道挤在一个块里）**按通道拆**成多条轨道。三处只能实测才知道的语义写进了
  解析器 docstring：① **走带块不算轨道**（只有速度 / 拍号 / 轨名，或者连名字都没有的空块），
  但**有名字没音符的空轨要保留**（实测 5 条：Euphoniums / Cimbassos / Solo Contrabass Tuba /
  Marimba / Xylophone —— 那是"编制里有这件乐器、这一段没演奏"）；
  ② **MuseScore 会在远超内容末尾的 tick 上再写一条速度事件**（实测内容到 264981 tick，
  它写 1970304，同为 120 BPM），契约里没有内容的时间轴虽然不显示，但状态栏的"时长"
  按速度轨最后一个点算 —— 留着会把 3:41 的曲子显示成 33:40，所以**内容末尾之后的速度点
  丢掉并记 warning**；③ 力度就是 note-on 的力度字节（不需要别的换算，实测快照 99 档）。
  `hostVersion` 放 **SMF 格式号**（`SMF 1`）—— 这种文件里没有"宿主版本"可放；
  `sampleRate` 文件里不存，给 44100 并记 warning。契约字段本身**没有新增**。
- v0.6 (2026-09-30): 支持 Studio One `.song`。`host` 加 `studioone`；ppq 480。`.song` 是 **ZIP**
  （`metainfo.xml` + `Song/song.xml` + `Song/mediapool.xml` + `Performances/<乐器>/<名>(n).musicx`），
  契约本身没变。两处只能实测才知道的语义写进了解析器 docstring：
  **位置单位跟轨道 `tempoFollow` 走**（0 = 秒 / 2 = 拍），**长度单位跟事件 `timeFormat` 走**
  （0 = 秒 / 2 = 拍）—— 两套单位分开决定，同一份工程里四种组合都有（判据：同一条轨复制出来的
  两份位置逐条相同、一份长度按拍一份按秒；不跟速度的 15 条轨位置 ×162/60 后 100% 落在整拍网格上，
  跟速度的轨则 0%）；**片段是窗口**，音符坐标存在源演奏文件里、`MusicPart.offset` 是片段左缘，
  窗口外的音符在 Studio One 里不属于该片段（实测 12291 个音符里 761 个落在窗口外，连同跨界的一起裁齐）。
  音符的 `quantize.start` / `quantize.velocity` 是**"改动前是多少"的记录，不要加到值上**
  （文件里的 `start` / `velocity` 就是宿主显示/播放的值；判据：M1 那条轨 160 个音符的
  `velocity + quantize.velocity` 恒等于宿主默认力度 0.6 —— 按"加上偏移"读整份工程的力度会
  塌成 76 / 102 两档，真值 44 档）。轨道种类沿用既有枚举：有 `instrumentOut` 乐器连接的
  Music 轨是 `instrument`，没有的是 `midi`（实测 18 条 Music 轨里 1 条是纯 MIDI 轨），
  总线通道画成 `bus` 空行。
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
    "host": "cubase",             // cubase | fl | reaper | bitwig | studioone | midi
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
- **Cubase / REAPER / MIDI 会填，FL 与 Studio One 恒为 `[]`**：`.cpr` 的 MIDI 事件流里带真正的 CC
  （实测一份工程里 CC1 5271 点 / CC11 2715 点 / CC64 178 点）；REAPER 的 MIDI 事件流
  里带 `0xBn` 事件（一份工程实测每个 MIDI 片段末尾都有一条 CC123「全部音符关」，照收）；
  FL 的 `.flp` 不存 CC；MIDI 的 CC 就在事件流里（`0xBn`），实测 7 种的点数见下面 MIDI 一节。
- 力度不需要控制器：`Note.velocity` 就是力度，前端直接画柱状。

## 宿主解析器

| 扩展名 | 模块 | 实测版本 |
|---|---|---|
| `.cpr` | `dawview/cpr_parser.py` | Cubase 15.0.30 / 15.0.21 WIN64 |
| `.flp` | `dawview/flp_parser.py` | FL Studio 25.2.4.5242 / 24.1.1.4285 |
| `.rpp` | `dawview/rpp_parser.py` | REAPER 7.67/win64 |
| `.bwproject` | `dawview/bwproject_parser.py` | Bitwig Studio 5.3.13 |
| `.song` | `dawview/song_parser.py` | Studio One 7.1.0.104182 |
| `.mid` / `.midi` | `dawview/midi_parser.py` | 标准 MIDI 文件（SMF 格式 1，实测 MuseScore 导出） |

六种格式的**线格式（wire format）笔记写在各自解析器的 docstring 里**（都是实测逆向出来的：
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

Studio One 特有的几点（都会影响契约字段）：

- **`.song` 是个 ZIP**：`metainfo.xml`（标题 / 生成器版本 / 速度 / 采样率）+ `Song/song.xml`
  （走带与全部轨道事件）+ `Song/mediapool.xml`（`mediaID` → 文件路径）+ `Devices/*.xml`
  （乐器通道、混音台）+ `Performances/<乐器>/<名>(n).musicx`（**音符在二进制演奏文件里**，
  每个 MIDI 片段一份）；`Envelopes/*.envelopex` 是自动化包络。XML 里的属性前缀 `x:` **没有**
  `xmlns` 声明，标准解析器会报 `unbound prefix`，解析器先补一个 xmlns 再解开。
- **位置单位跟轨道走、长度单位跟事件走**（这是本格式最大的坑）：
  轨道 `tempoFollow="0"` = 不跟速度 → 事件的 `start` 是**秒**；`="2"` → 是**拍**。
  事件的 `timeFormat="0"` → `length` 是**秒**；`="2"` → 是**拍**。
  实测判据两条：① 同一条轨复制出来的两份（VOLTA / 91V 军鼓，各 155 个事件）位置数字逐条相同，
  可一份 `timeFormat=2`、一份 `timeFormat=0` —— 说明位置单位不跟 `timeFormat` 走；
  ② 15 条 `tempoFollow=0` 的轨，原始 `start` 落在 1/4 拍网格上的比例 ~0%、× 162/60 之后 100%
  （整拍/十六分网格），而 `tempoFollow=2` 的轨反之 —— 两向都干净，没有含混的样本。
- **片段是窗口**：音符坐标在源演奏文件里，`MusicPart.offset` 是**片段左缘对应的源位置**，
  窗口 `[offset, offset+length]` 之外的音符在 Studio One 里不属于该片段（不显示不播放）；
  跨界的那部分裁到片段边界（实测 12291 个音符里 761 个落在窗口外）。
  MIDI 演奏文件（`.musicx`）里的音符位置/长度一律是**拍**。
- **`quantize.start` / `quantize.velocity` 是"改动前是多少"的记录，不要加到音符的位置 / 力度上**：
  文件里的 `start` / `velocity` 就是宿主当前显示/播放的值。判据：① 位置 —— 130 个带
  `quantize.start` 的音符里，`start` 落在 1/4 拍网格上的 0 个，而 `start + quantize.start`
  有 122 个，说明那批音符**曾经**在网格上、后来被挪开了，偏移记的是挪开前后的差；
  ② 力度（决定性）—— M1 那条轨 160 个音符的 `velocity` 各不相同（117 个取值），
  但 `velocity + quantize.velocity` **恒等于 0.6**（宿主默认画音符的力度）。
  按"加上偏移"读，整份工程的力度会塌成 76 / 102 两档，真值是 44 档。
- **乐器判定**：`Devices/musictrackdevice.xml` 里同名通道有 `Connection[id=instrumentOut]`
  的是乐器轨 → `instrument`，没有的（MIDI 只往外送）是 `midi`。
  实测 18 条 Music 轨里 17 条乐器、1 条纯 MIDI。`mediaType="Audio"` → `audio`。
- **总线轨**：`AutomationTrack` 画成 `bus` 空行（内容全是 `.envelopex` 自动化，本期不画）。
  `ChordTrack` / `ArrangerTrack` / `LyricsTrack` / `VideoTrack` / `MarkerTrack` 不是内容轨，跳过并记一条 warning。
  分层轨（`layerCount`）自己没有 Events，事件在 `List[id=Layers]` 的各层里，全部收下（契约里没有分层概念）。
- **力度**：演奏文件里是 0..1 的浮点，× 127 取整进契约。
- **不解析**：`.envelopex` 自动化（`controllers` 恒为 `[]`）、静音片段（契约没有静音字段）、
  `loopEnabled` 的循环展开、`speed` / `transpose` / `tune`（变速移调）—— 音频片段就是
  "从 `startTick` 到 `startTick+lengthTick` 的块"。音频素材**不在工程文件里**，
  解析器只给 `audioFile` 路径（工程旁边的采样文件 / 导出的 Bounce）。

MIDI（.mid）特有的几点（都会影响契约字段）：

- **一条 MTrk = 一条轨道、整条轨一个片段**：MIDI 文件里没有 part / pattern / 窗口这一层，
  片段是被契约"逼"出来的概念 —— 起点一律 0、长度到该轨最晚的内容（音符末尾或最后一条 CC，
  实测 33 条内容轨的长度各不相同：264981 / 259080 / 242400 …）。片段名 = 轨名。
  格式 0（一个块里塞了全部通道）按通道拆轨，名字补成 `轨名 · 通道 N`。
- **轨道种类一律 `midi`**：文件里没有插件信息，"有没有挂乐器"无从判断（不像 `.song` 能查
  `instrumentOut`、`.rpp` 能查 FX 链）；音色号（`0xCn`）读得出来，但契约里没有对应字段，不出口。
- **走带块不算轨道，有名字的空轨要保留**：只带速度 / 拍号 / 轨名（或者连名字都没有）且一个
  通道事件都没有的块，是走带（元信息）块 → 内容并进 `tempoMap` / `timeSig`，不作为轨道；
  反过来，**有名字但没有音符的轨保留成空行**（实测 5 条：Euphoniums / Cimbassos /
  Solo Contrabass Tuba / Marimba / Xylophone）—— 抹掉会让人以为编制少了声部。
- **ppq 用文件头里的 division**（实测 480），不做缩放；SMPTE 计时的文件（division 高位置 1）
  按标称速度重标到 480 ppq，秒数是对的，只是速度曲线在那类文件里本来就不表示拍速。
- **音符配对**：note-on ↔ note-off 按 `(通道, 音高)` 各自先入先出（同一个音高可以叠着按）；
  力度 0 的 note-on 就是 note-off；没配到 note-off 的音符按该轨结束 tick 补齐并记 warning，
  长度为 0 的音符按 1 tick 画。
- **CC 进 `controllers`**：按 `(通道, CC 号)` 归组，tick 相对片段起点（本格式片段起点就是 0，
  即绝对 tick）。实测一份 MuseScore 导出 7 种 CC：CC1 调制轮 15911 点、CC11 表情 682、
  CC16 641、CC21 636、CC22 514、CC58 84、CC64 延音踏板 619 —— 不填 `[]` 的宿主现在有
  Cubase / REAPER / MIDI 三家。
- **速度轨**：`0x51` 三字节 = 每四分音符微秒数。实测 MuseScore 把渐快渐慢写成**每 240 tick
  （八分音符）一个点的密集速度轨**（216 点），契约 v0.3 的阶梯语义天然吃这套。
  反算出来的 BPM 按 1e-3 收敛（微秒那一格被宿主截断过：441176 微秒 = 136.000145 BPM，
  不收敛标题栏会显示 17 位小数）；**内容末尾之后很远的速度点丢掉**（见 changelog）。
- **不解析**：弯音 / 触后 / sysex / 静音 / 循环，速度曲线的形状（阶梯就够用）。

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
