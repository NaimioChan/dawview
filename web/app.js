/* dawview 前端主控：取数据 -> 建视图 -> 交互（滚动 / 缩放 / 走带播放 / 主题）。 */

const state = {
  project: null,
  view: null,
  scrollX: 0,
  scrollY: 0,
  pxPerTick: 0.04,
  playheadTick: 0,
  playing: false,
  speed: 1.0,
  dataSource: 'file',
  lastTs: 0,
  pitchLo: 36,
  pitchHi: 84,
  // 显示选项（存 localStorage，见 VIEW_KEY）
  showChrome: true,        // 顶栏 + 状态栏
  showHeads: true,         // 左侧轨道名栏 / 钢琴键栏
  showClipNames: true,     // 片段上的名字
  followMode: 'page',      // 'page' 翻页 | 'center' 播放头固定居中
  rowH: ROW_H,             // 走带行高，Alt+滚轮可调
  semiH: SEMI_H,           // 钢琴窗半音行高，Alt+滚轮可调
  viewMode: 'arrange',     // 'arrange' 走带 | 'midi' 钢琴窗
  exportMode: false,       // 导出模式：隐藏网格线 / 上方标尺 / 滚动条（截图叠层用）
  // 播放动效
  fx: {
    on: true,              // 总开关
    note: true,            // 音符闪光
    clip: true,            // 片段入点光晕
    head: true,            // 播放头拖尾光晕
    strength: 1,           // 强度
    decay: 420,            // 衰减毫秒
  },
  hits: [],                // 播放头扫过的音符/片段命中记录
  hiddenTracks: new Set(), // 被隐藏的轨道下标（走带不画该行，钢琴窗不画该轨音符）
  kindFilter: '',          // 轨道选择器里按种类快速筛选：'' 全部 | midi | audio | automation | ...
  trackColors: {},         // 轨道自定色：工程轨道下标 -> '#rrggbb'（存 localStorage）
  swatchTrack: -1,         // 色卡选择器当前对着哪条轨道（画布下标），-1 = 关着
  // 钢琴窗下部的力度 / CC 栏（吃契约 v0.3 的 notes[].velocity 与 controllers[]）
  lanes: [],               // [{id, kind:'velocity'|'cc', cc}]，默认空 = 不显示
  laneH: 84,               // 单栏绘制区高度（px），标题条另算
  // 用户音频轨（自己导入的音频，见 web/audio.js）—— 数据在工程旁边的
  // .dawview/audio-lanes.json 里，跟 DAW 工程解析出来的轨道是两回事
  audioLanes: [],          // 契约 v0.6：{id, name, muted, clips:[...]}
  audioDir: '',            // 存哪儿（设置菜单里显示给用户看）
  audioAvailable: false,   // 有本地服务（能导入 / 能存 / 能播）吗
  audioWritable: true,     // 目录可写吗（只读盘上只在本次会话有效）
  audioSnap: true,         // 拖动吸附到拍（显示偏好，存 localStorage）
  audioPlay: true,         // 播放时出声（显示偏好）
  audioShow: true,         // 显示音频区（显示偏好）
  audioHover: null,        // {lane, clip, edge}：鼠标下的音频片段（画裁剪手柄用）
  audioDrag: null,         // {lane, clip, edge, orig, readout, moved}：正在拖的片段
  audioDrop: null,         // {tick}：文件拖到画布上时的落点提示线
  audioSaving: false,      // 正在往服务端存
  tempo: null,             // 速度轨预处理结果（buildTempo），播放时按它变速
  remoteColors: null,      // 服务端那份轨道配色 {project, map}（boot 时拉 / 拉不到就 null）
  // 多窗口联动（OBS 浏览器源）的计数器，验证脚本读它
  relay: { clientId: '', controls: 0, prefs: 0, plays: 0, sends: 0, lastAction: '', actions: {} },
};

const VIEW_KEY = 'dawview.view';
const ROW_H_MIN = 22;
const ROW_H_MAX = 140;
const SEMI_H_MIN = 7;
const SEMI_H_MAX = 40;
const LANE_H_MIN = 40;
const LANE_H_MAX = 240;
let laneSeq = 0;           // 栏位 id 自增（只在本页内存里用）

function currentViewPrefs() {
  return {
    showChrome: state.showChrome, showHeads: state.showHeads,
    showClipNames: state.showClipNames, followMode: state.followMode,
    rowH: state.rowH, semiH: state.semiH, viewMode: state.viewMode,
    exportMode: state.exportMode, pxPerTick: state.pxPerTick,
    speed: state.speed, fx: state.fx,
    hiddenTracks: [...state.hiddenTracks],
    kindFilter: state.kindFilter,
    lanes: state.lanes,
    laneH: state.laneH,
    // 音频区的显示偏好（数据本身不在这儿，走 /audiolanes）
    audioSnap: state.audioSnap, audioPlay: state.audioPlay, audioShow: state.audioShow,
  };
}

function saveViewPrefs() {
  try {
    localStorage.setItem(VIEW_KEY, JSON.stringify(currentViewPrefs()));
  } catch (e) { /* 隐私模式忽略 */ }
  pushPrefs();             // 顺带同步给别的窗口（OBS 浏览器源），没有后端时是空操作
}

function loadViewPrefs() {
  try {
    const raw = localStorage.getItem(VIEW_KEY);
    if (raw) return JSON.parse(raw);
  } catch (e) { /* 忽略 */ }
  return {};
}

const el = {
  scroll: document.getElementById('scroll'),
  spacer: document.getElementById('spacer'),
  canvas: document.getElementById('tl'),
  projInfo: document.getElementById('proj-info'),
  posLabel: document.getElementById('pos-label'),
  zoomLabel: document.getElementById('zoom-label'),
  status: document.getElementById('status-text'),
  empty: document.getElementById('empty'),
  emptyMsg: document.getElementById('empty-msg'),
  btnPlay: document.getElementById('btn-play'),
  btnHome: document.getElementById('btn-home'),
  btnSettings: document.getElementById('btn-settings'),
  menu: document.getElementById('settings-menu'),
  menuGroups: document.getElementById('menu-groups'),
  menuPane: document.getElementById('menu-pane'),
  tracksPicker: document.getElementById('tracks-picker'),
  btnTracks: document.getElementById('btn-tracks'),
  trackMenu: document.getElementById('track-menu'),
  trackMenuFilter: document.getElementById('track-menu-filter'),
  trackMenuList: document.getElementById('track-menu-list'),
  trackMenuCount: document.getElementById('track-menu-count'),
  trackMenuGrad: document.getElementById('track-menu-grad'),
  btnTracksAll: document.getElementById('btn-tracks-all'),
  swatchPop: document.getElementById('swatch-pop'),
  swatchDot: document.getElementById('swatch-dot'),
  swatchName: document.getElementById('swatch-name'),
  swatchGrid: document.getElementById('swatch-grid'),
  swatchCustom: document.getElementById('swatch-custom'),
  swatchReset: document.getElementById('swatch-reset'),
  audioFile: document.getElementById('audio-file'),
  dropHint: document.getElementById('drop-hint'),
  btnAudio: document.getElementById('btn-audio'),
  toast: document.getElementById('toast'),
};

/* ------------------------------------------------------------ 小提示气泡 */

let toastTimer = 0;
function toast(msg, ms = 2200) {
  el.toast.textContent = msg;
  el.toast.hidden = false;
  el.toast.classList.remove('fade');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => {
    el.toast.classList.add('fade');
    setTimeout(() => { el.toast.hidden = true; }, 400);
  }, ms);
}

/* ------------------------------------------------ 后端数据（契约 v0.1） */

// 取数据只有一条路：本地服务（dawview/server.py）把 web/ 和 project.json 一起发过来。
// 没跑后端、直接开 index.html 时会 fetch 失败，界面上给一句能照着做的提示。
async function loadProject() {
  const res = await fetch('project.json', { cache: 'no-store' });
  if (!res.ok) throw new Error(`project.json 读取失败（HTTP ${res.status}）`);
  state.dataSource = 'file';
  return res.json();
}

/* ------------------------------------- 多窗口联动（给 OBS 浏览器源补短板） */

// 一个 dawview 进程可以同时挂几个页面：app 窗口，加上 OBS 的浏览器源（那是**另一个
// 浏览器实例**，也可能是外部浏览器）。它们的 localStorage 各是各的、键鼠也进不去对方，
// 于是靠服务端当中转：设置走 /prefs 的共享副本，操作走 /control 的广播。
//   POST /prefs   {view, theme, colors, client}   —— 存一份 + 广播给其它窗口
//   POST /control {action, params, client}        —— 广播给其它窗口执行
// 两个接口都要带上自己的 client id（SSE hello 里拿到的），服务端才不会把消息回给发起者。
const RELAY = {
  TICK_MS: 250,      // 播放中同步位置的间隔（毫秒）
  TICK_PX: 12,       // 位置差多少像素才值得纠正（比这还小看不出来，就别抖）
  MASTER_MS: 15000,  // 谁最后操作谁当播放时钟的主，这么久没动作才轮到别人
};

// 带 ?role=host 的窗口是主窗口（app.py 开的那个）：设置以它为准 ——
// 只有它"启动时用自己的 localStorage 而不是先拉服务端那份"。
const IS_HOST = new URLSearchParams(location.search).get('role') === 'host';

let serverClientId = '';              // 服务端给的客户端 id（没有后端时是空的）
let remoteApplying = 0;               // >0 = 正在套用远端来的动作/设置，此时不回发（防回声）
// 上一次"本窗口主动操作"的时刻。初值必须是 -Infinity 而不是 0 ——
// 0 会被当成"刚刚操作过"，让一个从没被碰过的页面也去发位置校准，两端互相顶。
// 谁操作过谁就是时钟主；每发一次校准都算操作，所以播着播着一直是它。
let lastActedAt = -Infinity;
let lastTickSyncAt = 0;

function relayReady() {
  return !!serverClientId && remoteApplying === 0;
}

function postJson(path, obj) {
  return fetch(path, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(obj),
    cache: 'no-store',
  }).then((r) => (r.ok ? r.json() : null)).catch(() => null);
}

async function getJson(path) {
  try {
    const r = await fetch(path, { cache: 'no-store' });
    return r.ok ? await r.json() : null;
  } catch (e) {
    return null;        // 静态打开页面（没有后端）时走这条路
  }
}

// 把本窗口的设置推给服务端。内容没变服务端不会广播，所以两边互相回声也只会来回一次。
function pushPrefs() {
  if (!relayReady()) return;
  postJson('/prefs', {
    view: currentViewPrefs(),
    theme: { name: themeName, custom: themeCustom },
    colors: { project: colorBucketKey(), map: { ...state.trackColors } },
    client: serverClientId,
  });
}

// 本窗口自己存过设置没有？OBS 那个浏览器实例的 profile 是空的 —— 它要从服务端拿。
function hasLocalPrefs() {
  try {
    return !!(localStorage.getItem(VIEW_KEY) || localStorage.getItem(STORE_KEY)
      || localStorage.getItem(COLORS_KEY));
  } catch (e) { return false; }
}

// 启动时拉一份服务端设置：主窗口自己有设置就不用被覆盖，别的页面（OBS 浏览器源）照单全收。
async function pullPrefs() {
  const remote = await getJson('/prefs');
  if (!remote || !Object.keys(remote).length) return false;
  if (IS_HOST && hasLocalPrefs()) return false;
  return applyRemotePrefs(remote, false);
}

// 套用一份设置（boot 时来自 /prefs，运行中来自 SSE 广播）
function applyRemotePrefs(payload, live) {
  if (!payload || typeof payload !== 'object') return false;
  remoteApplying++;
  try {
    if (payload.theme && typeof payload.theme === 'object') {
      themeName = THEMES[payload.theme.name] ? payload.theme.name : themeName;
      themeCustom = (payload.theme.custom && typeof payload.theme.custom === 'object')
        ? payload.theme.custom : {};
      applyTheme(themeName, themeCustom);
      saveTheme({ name: themeName, custom: themeCustom });
    }
    if (payload.view && typeof payload.view === 'object') applyViewPrefs(payload.view);
    if (payload.colors && typeof payload.colors === 'object') {
      state.remoteColors = { project: payload.colors.project, map: payload.colors.map || {} };
      mergeRemoteColors();
    }
  } finally {
    remoteApplying--;
  }
  state.relay.prefs += 1;
  if (live) {                       // 运行中收到广播：把视图按新设置重建一遍
    applyHeads();
    updateStatusLine();
    renderTrackMenu();
    syncSettingsUi();
    paint();
  }
  return true;
}

// 服务端那份轨道配色（同一个工程才套用；换工程不串色）
function mergeRemoteColors() {
  const remote = state.remoteColors;
  if (!remote || !state.project || remote.project !== colorBucketKey()) return false;
  const map = {};
  for (const [k, v] of Object.entries(remote.map || {})) {
    const i = parseInt(k, 10);
    if (Number.isInteger(i) && i >= 0 && HEX_RE.test(v)) map[i] = String(v).toLowerCase();
  }
  state.trackColors = map;
  saveTrackColors();                // 写回本地；远端套用中，不会回推
  renderTrackMenu();
  renderSwatchPop();
  paint();
  return true;
}

// 可以被中继的动作表。键必须和 dawview/server.py 的 CONTROL_ACTIONS 一致
// （服务端按白名单放行），改一边记得改另一边。
const CONTROL_ACTIONS = {
  play: () => setPlaying(true),
  pause: () => setPlaying(false),
  toggleplay: () => setPlaying(!state.playing),
  home: () => goHome(),
  seek: (p) => { if (isFinite(p.tick)) seekToTick(p.tick); },
  tick: (p) => { if (isFinite(p.tick)) syncTick(p.tick); },          // 播放中校准位置
  zoom: (p) => { if (isFinite(p.factor)) zoom(p.factor); },
  zoomto: (p) => applyZoomTo(p),
  fit: () => fit(),
  setrowh: (p) => { if (isFinite(p.value)) setRowHeight(p.value); },
  setsemih: (p) => { if (isFinite(p.value)) setSemiHeight(p.value); },
  setlaneh: (p) => { if (isFinite(p.value)) setLaneHeight(p.value); },
  setviewmode: (p) => setViewMode(p.mode),
  setclean: (p) => setClean(!!p.on),
  setexport: (p) => setExportMode(!!p.on),
  setheads: (p) => setHeads(!!p.on),
  setclipnames: (p) => setClipNames(!!p.on),
  setfollow: (p) => setFollowMode(p.mode),
  setspeed: (p) => { if (isFinite(p.value)) setSpeed(p.value); },
  setfx: (p) => { if (p.patch && typeof p.patch === 'object') setFx(p.patch); },
  setlanes: (p) => setLanesFromRemote(p.lanes),
  track: (p) => setTrackVisible(p.index, !!p.on),
  trackall: () => toggleAllTracks(),
  sethidden: (p) => setHiddenFromRemote(p.hidden),
  setaudiosnap: (p) => setAudioSnap(!!p.on),
  setaudioplay: (p) => setAudioPlay(!!p.on),
  setaudioshow: (p) => setAudioShow(!!p.on),
};

function sendControl(action, params) {
  if (!relayReady()) return;
  lastActedAt = performance.now();   // 谁在操作谁是播放时钟的主
  state.relay.sends += 1;
  postJson('/control', { action, params: params || {}, client: serverClientId });
}

function applyRemoteControl(msg) {
  const fn = msg && CONTROL_ACTIONS[msg.action];
  if (typeof fn !== 'function') return;
  remoteApplying++;
  try {
    fn(msg.params || {});
  } finally {
    remoteApplying--;
  }
  state.relay.controls += 1;
  state.relay.lastAction = msg.action;
  // 按动作分别计数：验证脚本要说"收到了 play"，而 lastAction 会被紧随其后的 tick 顶掉
  state.relay.actions[msg.action] = (state.relay.actions[msg.action] || 0) + 1;
}

// 两个窗口各跑各的 rAF，时间长了必然飘。时钟主窗口（最近被操作过的那个）定期报位置，
// 别的窗口差得"看得出来"（约 12px）才纠正一次 —— 每帧都对齐反而会抖。
// 没被碰过的页面一次都不发：否则两个窗口会互相顶来顶去。
function syncTick(tick) {
  if (!state.playing) return;
  const tol = Math.min(600, Math.max(6, RELAY.TICK_PX / Math.max(state.pxPerTick, 0.001)));
  if (Math.abs(state.playheadTick - tick) <= tol) return;
  const jump = Math.abs(state.playheadTick - tick);
  state.playheadTick = tick;
  updatePosLabel();
  // 差得超过一小节就不是"抖一下"了：音频也跟着重排，不然声音和画面差半拍
  if (jump > state.view.barTicks) audioStart();
  paint();
}

function maybeSyncTick(ts) {
  if (!relayReady() || !state.playing) return;
  if (ts - lastActedAt > RELAY.MASTER_MS) return;      // 最近没操作过：老老实实当跟随方
  if (ts - lastTickSyncAt < RELAY.TICK_MS) return;
  lastTickSyncAt = ts;
  sendControl('tick', { tick: state.playheadTick });   // 发一次就算操作一次，播着一直是主
}

// 告诉后端"页面还开着"：SSE 长连接，窗口一关连接就断，后端据此退出进程。
// 为什么不用定时 fetch 心跳：后台标签页和 OBS 浏览器源里的 setInterval 会被
// 浏览器节流（慢到一分钟一次），心跳法会把"还在用"误判成"窗口关了"而提前退出。
// 同一条连接还负责收 hello（自己的 id）、control（别的窗口的操作）、prefs（设置）。
function connectToServer() {
  if (typeof EventSource !== 'function') return;
  let opened = false;
  const es = new EventSource('/events');
  es.addEventListener('open', () => {
    opened = true;
    state.dataSource = 'server';     // 状态栏显示"本地服务"
    updateStatusLine();
  });
  es.addEventListener('hello', (e) => {
    try {
      serverClientId = JSON.parse(e.data).client || '';
    } catch (err) { /* 消息坏了就当没有 id：只是收不到自己的回声，功能不受影响 */ }
    state.relay.clientId = serverClientId;
    pushPrefs();                     // 连上先把自己这份推上去（没变化服务端不会广播）
  });
  es.addEventListener('control', (e) => {
    runRemote(() => applyRemoteControl(JSON.parse(e.data)));
  });
  es.addEventListener('prefs', (e) => {
    runRemote(() => applyRemotePrefs(JSON.parse(e.data), true));
  });
  es.addEventListener('audiolanes', (e) => {
    runRemote(() => {
      const data = JSON.parse(e.data);
      applyRemoteAudioLanes(data.lanes);
    });
  });
  es.addEventListener('error', () => {
    // 压根没有后端（静态打开、或别的静态服务器）：关掉，别让 EventSource 一直重连刷屏
    if (!opened) es.close();
  });
  window.addEventListener('pagehide', () => es.close());
}

function runRemote(fn) {
  try {
    fn();
  } catch (err) {
    console.warn('[dawview] 远端消息没处理成功：', err);
  }
}

/* ---------------------------------------------------------------- 视图 */

function rebuildView() {
  // 只把"显示的轨道"交给视图：走带少几行、钢琴窗少几轨音符，一处生效两处都变。
  // 视图里每条轨道挂上 projectIndex —— 过滤后 view.tracks 的下标 ≠ 工程下标，
  // 而轨道自定色 / 隐藏状态都是按工程下标记的。
  const tracks = [];
  state.project.tracks.forEach((t, i) => {
    if (!state.hiddenTracks.has(i)) tracks.push({ ...t, projectIndex: i });
  });
  const notes = [];
  for (const t of tracks) {
    for (const c of t.clips) for (const n of c.notes || []) notes.push(n.pitch);
  }
  if (notes.length) {
    state.pitchLo = Math.max(0, Math.min(...notes) - 2);
    state.pitchHi = Math.min(127, Math.max(...notes) + 2);
  }
  const opts = {
    pxPerTick: state.pxPerTick,
    pitchLo: state.pitchLo,
    pitchHi: state.pitchHi,
    headW: state.showHeads ? (state.viewMode === 'midi' ? KEYS_W : HEAD_W) : 0,
    tempo: state.tempo,           // 音频片段的右缘要按速度轨反算回 tick
    // 用户音频轨：只在走带视图里画；「显示音频区」关掉时也不画（数据还在）
    audioLanes: state.viewMode === 'arrange' && state.audioShow ? state.audioLanes : [],
  };
  const project = { ...state.project, tracks };
  state.view = state.viewMode === 'midi'
    ? makeMidiView(project, { ...opts, semiH: state.semiH, lanes: state.lanes, laneH: state.laneH })
    : makeView(project, { ...opts, rowH: state.rowH });
  resizeSpacer();
}

function resizeSpacer() {
  const size = contentSize(state.view, el.scroll.clientWidth);
  el.spacer.style.width = size.width + 'px';
  // 画布本身（sticky，一屏高）已经贡献了视口那一段高度，spacer 只补差额，
  // 否则滚动范围会多出一屏（滚到底能滚出空白）。
  el.spacer.style.height = Math.max(0, size.height - el.scroll.clientHeight) + 'px';
}

function paint() {
  if (!state.view) return;
  state.scrollX = el.scroll.scrollLeft;
  state.scrollY = el.scroll.scrollTop;
  draw(el.canvas, state.view, state);
}

/* -------------------------------------------------------------- 走带播放 */

/* 速度轨（契约 v0.3：阶梯语义）——[[tick, bpm], ...] 预处理成三张平行数组，
   tick<->秒 走二分查找，播放时按"当前 tick 处的速度"推进。 */
function buildTempo(project) {
  const meta = (project && project.meta) || {};
  const ppq = meta.ppq || 480;
  const byTick = new Map();
  for (const pair of (project && project.tempoMap) || []) {
    if (!Array.isArray(pair) || pair.length < 2) continue;
    const t = Number(pair[0]);
    const b = Number(pair[1]);
    if (!isFinite(t) || !isFinite(b) || t < 0 || b <= 0) continue;
    byTick.set(Math.round(t * 1e6) / 1e6, b);     // 同 tick 取最后一个
  }
  const fallback = Number(meta.bpm) > 0 ? Number(meta.bpm) : 120;
  if (!byTick.size) byTick.set(0, fallback);
  const ticks = [...byTick.keys()].sort((a, b) => a - b);
  if (ticks[0] > 0) ticks.unshift(0);             // 首点必须在工程开头
  const bpms = new Array(ticks.length);
  let last = fallback;
  for (let i = ticks.length - 1; i >= 0; i--) {   // 倒着填：补出来的点用后面第一个真速度
    last = byTick.has(ticks[i]) ? byTick.get(ticks[i]) : last;
    bpms[i] = last;
  }
  const times = [0];
  for (let i = 1; i < ticks.length; i++) {        // 阶梯：每段用段首速度
    times.push(times[i - 1] + (ticks[i] - ticks[i - 1]) / ppq * 60 / bpms[i - 1]);
  }
  const idxAt = (tick) => {
    if (tick <= ticks[0]) return 0;
    let lo = 0;
    let hi = ticks.length - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (ticks[mid] <= tick) lo = mid; else hi = mid - 1;
    }
    return lo;
  };
  const end = ticks.length - 1;
  return {
    ppq, ticks, bpms, times,
    points: ticks.length,
    bpmAt(tick) { return bpms[idxAt(tick)]; },
    secAt(tick) {
      const i = idxAt(tick);
      return times[i] + (tick - ticks[i]) / ppq * 60 / bpms[i];
    },
    tickAtSec(sec) {
      if (!(sec > 0)) return 0;
      let i = end;
      while (i > 0 && times[i] > sec) i--;
      return ticks[i] + (sec - times[i]) * bpms[i] / 60 * ppq;
    },
    totalSec: times[end],        // times[i] 就是第 i 个速度点的绝对秒数
  };
}

// 某个 tick 处的推进速率（tick/秒）——有速度轨就按轨上的速度，没有就按 meta.bpm
function rateAt(tick) {
  const meta = (state.project && state.project.meta) || {};
  if (state.tempo) return (state.tempo.bpmAt(tick) / 60) * state.tempo.ppq;
  return ((meta.bpm || 120) / 60) * (meta.ppq || 480);
}

function ticksPerSecond() {
  return rateAt(state.playheadTick);
}

function frame(ts) {
  if (!state.playing) return;
  if (!state.lastTs) state.lastTs = ts;
  const dt = Math.min(0.25, (ts - state.lastTs) / 1000);
  state.lastTs = ts;
  const prev = state.playheadTick;
  // 变速播放：先用起点速度估半步，再用中点速度定这一步（一阶预测-校正）。
  // 变速点密集时（Cubase 那份工程 1127 个点）整帧套用一个旧速度会明显跑偏。
  const half = prev + dt * rateAt(prev) * state.speed * 0.5;
  state.playheadTick = prev + dt * rateAt(half) * state.speed;

  const end = state.view.lengthTicks;
  if (state.playheadTick >= end) {
    state.playheadTick = end;
    setPlaying(false);
  }
  collectHits(prev, state.playheadTick);
  pruneHits();
  followPlayhead();
  maybeSyncTick(ts);                 // 时钟主窗口定期报位置，别的窗口跟着校准
  updatePosLabel();
  paint();
  if (state.playing) requestAnimationFrame(frame);
}

// 播放头这一帧扫过了哪些音符/片段入点 → 记下来给绘制层做动效
function collectHits(prev, now) {
  const fx = state.fx;
  if (!fx.on || now <= prev) return;
  if (now - prev > state.view.barTicks) return;   // 跳播不触发成片动效
  const t = performance.now();
  const v = state.view;

  if (v.mode === 'midi') {
    if (fx.note) {
      for (const n of v.notes) {
        if (n.tick > prev && n.tick <= now) state.hits.push({ key: noteHitKey(n.pitch, n.tick), t });
      }
    }
    return;
  }

  for (let ti = 0; ti < v.tracks.length; ti++) {
    for (const clip of v.tracks[ti].clips || []) {
      if (fx.clip && clip.startTick > prev && clip.startTick <= now) {
        state.hits.push({ key: clipHitKey(ti, clip.startTick), t });
      }
      if (!fx.note || clip.kind !== 'midi') continue;
      for (const n of clip.notes || []) {
        const abs = clip.startTick + n.startTick;
        if (abs > prev && abs <= now) state.hits.push({ key: noteHitKey(n.pitch, abs), t });
      }
    }
  }
}

function pruneHits() {
  if (!state.hits.length) return;
  const decay = state.fx.decay || 400;
  const now = performance.now();
  state.hits = state.hits.filter((h) => now - h.t < decay);
}

function followPlayhead() {
  const x = tickToX(state.view, state.playheadTick);
  const headW = state.view.headW;
  const vw = el.scroll.clientWidth;

  // 居中：播放头钉在时间线区正中，视口连续滚动
  if (state.followMode === 'center') {
    el.scroll.scrollLeft = Math.max(0, x - headW - (vw - headW) / 2);
    return;
  }

  const left = el.scroll.scrollLeft;
  const right = left + vw;
  if (x > right - 80 || x < left + headW) {
    el.scroll.scrollLeft = Math.max(0, x - vw * 0.35);
  }
}

function setPlaying(on) {
  const was = state.playing;
  state.playing = on;
  state.lastTs = 0;
  if (!on) state.hits = [];          // 停下就不留动效残影
  el.btnPlay.textContent = on ? '❚❚' : '▶';
  if (on) {
    audioStart();                    // 音频轨跟着走带一起出声
    requestAnimationFrame(frame);
  } else {
    audioStop();
  }
  if (was !== on) {
    state.relay.plays += 1;
    sendControl(on ? 'play' : 'pause');   // 别的窗口（OBS 那个画面）跟着一起动
  }
}

// 回到开头 / 定位到某个 tick：本地操作和中继过来的动作共用这两个函数
function goHome() {
  state.playheadTick = 0;
  state.hits = [];
  el.scroll.scrollLeft = 0;
  updatePosLabel();
  if (state.playing) audioStart();     // 正在播时改变位置：音频重新排一次
  paint();
}

// 画布上的横向坐标换算：鼠标 clientX -> **内容坐标**。
//
// 片段/音符/音频片段都是按内容坐标画的（画的时候统一减了 state.scrollX），所以凡是
// "从鼠标位置反推 tick、或跟画出来的片段比坐标"的地方，都必须先加回横向滚动量。
// 漏加的表现：横向滚动后点标尺定位偏左（偏多少 = 滚动量），越往右滚偏得越多；
// 缩放后内容宽过视口就会有滚动量，所以看着像"只在某个缩放下出问题"。
//
// 反例：音频区标题条、轨道头、轨道头上的色卡是**钉在视口里**的（x 不随滚动变），
// 那些命中判定保持视口坐标，不要用这个函数。
function contentX(clientX) {
  return clientX - el.canvas.getBoundingClientRect().left + state.scrollX;
}

// resched=false 用于"别的声音也别跳"的小幅校准（窗口联动的位置纠偏）
function seekToTick(tick, resched = true) {
  state.playheadTick = Math.max(0, Math.min(state.view.lengthTicks, Math.round(tick)));
  state.hits = [];
  updatePosLabel();
  if (state.playing && resched) audioStart();
  paint();
}

function updatePosLabel() {
  const tick = state.playheadTick;
  const meta = (state.project && state.project.meta) || {};
  const bpm = state.tempo ? state.tempo.bpmAt(tick) : (meta.bpm || 0);
  el.posLabel.textContent = `${barLabel(state.view, tick)} · ${bpm.toFixed(1)} BPM`;
}

/* ---------------------------------------- 用户音频轨（自己导入的音频） */

/* 数据来自 GET /audiolanes.json（可写，和只读的工程契约分开传），
   音频文件走 POST /media 上传、GET /media/<名字> 取回；播放是 Web Audio
   （web/audio.js 的 audioEngine）。这里管三件事：取存数据、界面上的拖/裁、
   把播放排期喂给引擎。 */

const AUDIO_SAVE_MS = 250;      // 存盘防抖：拖着走的时候别每帧都发一遍
const AUDIO_LEAD = 0.08;        // 起播提前量（秒）：排到音频时钟未来一点点，别"一上来就迟到"
let audioSaveTimer = 0;
let audioIdSeq = 0;

function nextAudioId(prefix) {
  audioIdSeq += 1;
  return `${prefix}${Date.now().toString(36)}${audioIdSeq.toString(36)}`;
}

// 吸附粒度 = 一拍。速度轨只改变"一拍多长秒"，tick 域里拍长恒定，所以直接取 ppq。
function audioGridTicks() {
  return (state.view && state.view.beatTicks) || (state.project && state.project.meta
    ? state.project.meta.ppq || 480 : 480);
}

// 鼠标 x -> tick（带吸附；按住 Alt 或关掉吸附就不吸）
function audioTickAt(clientX, bypassSnap) {
  const raw = xToTick(state.view, contentX(clientX));
  const tick = (state.audioSnap && !bypassSnap) ? audioSnapTick(raw, audioGridTicks()) : raw;
  return Math.max(0, Math.round(tick));
}

function audioSrcDur(clip) {
  const info = audioEngine.info(clip.file);
  return info && info.durSec ? info.durSec : (Number(clip.srcDurSec) || 0);
}

// 状态栏 / 拖动读数用的短标签
function audioReadout(clip) {
  const tempo = state.tempo;
  const s = audioStartSec(tempo, clip);
  const tick = Math.round(clip.startTick);
  const bar = state.view ? barLabel(state.view, tick) : String(tick);
  return `${bar} · +${s.toFixed(2)}s · 取 ${clip.srcOffsetSec.toFixed(2)}–`
    + `${(clip.srcOffsetSec + clip.lengthSec).toFixed(2)}s`;
}

/* ------------------------------------------------------------ 取存数据 */

async function loadAudioLanes() {
  const data = await getJson('/audiolanes.json');
  if (!data || typeof data !== 'object' || !data.dir) {
    // 没有本地服务（直接开 index.html / 静态服务器）：音频区只读不了也存不了
    state.audioAvailable = false;
    state.audioLanes = [];
    return false;
  }
  state.audioAvailable = true;
  state.audioDir = String(data.dir);
  state.audioWritable = data.writable !== false;
  state.audioLanes = normAudioLanes(data.lanes);
  return true;
}

// 存一份到服务端（防抖）：拖完松手、改完静音都会走这里
function scheduleAudioSave() {
  if (!state.audioAvailable) return;
  state.audioSaving = true;
  clearTimeout(audioSaveTimer);
  audioSaveTimer = setTimeout(pushAudioLanes, AUDIO_SAVE_MS);
  paint();
}

async function pushAudioLanes() {
  const res = await postJson('/audiolanes', { lanes: state.audioLanes, client: serverClientId });
  state.audioSaving = false;
  if (!res || !res.ok) {
    toast('音频轨没存上：本地服务没响应');
  } else if (res.writable === false) {
    state.audioWritable = false;
    toast('工程目录写不进去：音频轨只在这次会话里有效');
  }
  paint();
}

// 音频轨变了之后的统一收尾：重画 + 状态栏 + 存盘。数据本身先改 state.audioLanes。
function afterAudioChange(save = true) {
  rebuildView();
  updateStatusLine();
  paint();
  if (save) scheduleAudioSave();
}

// 别的窗口改了音频轨（SSE 广播）：照单全收，但不再回存（防回声）
function applyRemoteAudioLanes(lanes) {
  state.audioLanes = normAudioLanes(lanes);
  state.audioHover = null;
  state.audioDrag = null;
  loadAudioPeaks();
  afterAudioChange(false);
}

/* ------------------------------------------------------------ 导入音频 */

async function uploadAudio(file) {
  const res = await fetch(`/media?name=${encodeURIComponent(file.name)}`, {
    method: 'POST', body: file, cache: 'no-store',
  });
  if (!res.ok) {
    const err = await res.json().catch(() => null);
    throw new Error((err && err.error) ? err.error : `HTTP ${res.status}`);
  }
  return res.json();          // {file, name, bytes, sha1, dup}
}

function newAudioLane(name) {
  const lane = { id: nextAudioId('al'), name: name || `音频 ${state.audioLanes.length + 1}`,
                 muted: false, clips: [] };
  state.audioLanes.push(lane);
  return state.audioLanes.length - 1;
}

/* 导入一批文件：每个文件一轨（落在指定轨道上时就用那一条），位置放 playhead
 * 或拖动落点。返回真正加进去的片段。 */
async function importAudioFiles(files, opts = {}) {
  const list = [...(files || [])];
  if (!list.length) return [];
  if (!state.audioAvailable) {
    toast('音频轨要连本地服务才有（用 run.bat 打开，别直接开 index.html）');
    return [];
  }
  audioEngine.ensureCtx();               // 用户操作里建上下文，浏览器才允许出声
  const atTick = audioSnapToGrid(opts.tick !== undefined ? opts.tick : state.playheadTick);
  const made = [];
  for (const file of list) {
    if (!audioExtOk(file.name)) { toast(`${file.name}：不是常见音频格式`); continue; }
    if (file.size > AUDIO_MAX_BYTES) { toast(`${file.name}：文件太大（上限 512 MB）`); continue; }
    try {
      const up = await uploadAudio(file);
      const info = await audioEngine.load(up.file);
      if (!info || !(info.durSec > 0)) {
        toast(`${file.name}：浏览器解不开这个编码`);
        continue;
      }
      const laneIdx = (Number.isInteger(opts.lane) && opts.lane >= 0 && state.audioLanes[opts.lane])
        ? opts.lane : newAudioLane(file.name);
      const clip = {
        id: nextAudioId('ac'), name: file.name, file: up.file,
        startTick: atTick, srcOffsetSec: 0,
        lengthSec: Math.round(info.durSec * 1e6) / 1e6,
        srcDurSec: Math.round(info.durSec * 1e6) / 1e6,
      };
      state.audioLanes[laneIdx].clips.push(clip);
      made.push(clip);
    } catch (err) {
      toast(`导入失败：${err.message || err}`);
    }
  }
  if (made.length) {
    state.audioShow = true;
    afterAudioChange();
    const dup = made.length > 1 ? `${made.length} 个文件` : made[0].name;
    toast(`已导入 ${dup}（拖两头改长度，拖中间挪位置）`);
  }
  return made;
}

// 拖放 / 导入时的落点也要过一遍吸附
function audioSnapToGrid(tick) {
  const t = Number(tick) || 0;
  return Math.max(0, Math.round(state.audioSnap ? audioSnapTick(t, audioGridTicks()) : t));
}

// 波形后台加载：到一份重画一次（大文件要几百毫秒）
async function loadAudioPeaks() {
  if (!state.audioAvailable) return 0;
  const files = state.audioLanes.flatMap((l) => (l.clips || []).map((c) => c.file));
  if (!files.length) return 0;
  return audioEngine.loadAll(state.audioLanes, () => paint());
}

/* ------------------------------------------------------- 增删改（界面用） */

function addAudioLaneAndShow() {
  if (!state.audioAvailable) { toast('音频轨要连本地服务才有'); return -1; }
  state.audioShow = true;
  const i = newAudioLane();
  afterAudioChange();
  toast('加了一条音频轨：拖音频文件进这一行，或点「导入音频」');
  return i;
}

function removeAudioClip(laneIdx, clipIdx) {
  const lane = state.audioLanes[laneIdx];
  if (!lane || !lane.clips[clipIdx]) return;
  const [gone] = lane.clips.splice(clipIdx, 1);
  if (!lane.clips.length) state.audioLanes.splice(laneIdx, 1);   // 空了就整轨收掉
  afterAudioChange();
  toast(`已删掉「${gone.name}」（素材还留在 .dawview/media 里）`);
}

function removeAudioLane(laneIdx) {
  const lane = state.audioLanes[laneIdx];
  if (!lane) return;
  state.audioLanes.splice(laneIdx, 1);
  afterAudioChange();
  toast(`已删掉音频轨「${lane.name}」`);
}

function toggleAudioMute(laneIdx) {
  const lane = state.audioLanes[laneIdx];
  if (!lane) return;
  lane.muted = !lane.muted;
  afterAudioChange();
  if (state.playing) audioStart();          // 静音立刻生效（重新排一次）
  toast(lane.muted ? `「${lane.name}」已静音` : `「${lane.name}」恢复出声`);
}

function setAudioSnap(on) {
  state.audioSnap = !!on;
  saveViewPrefs();
  sendControl('setaudiosnap', { on: state.audioSnap });
  syncSettingsUi();
  paint();
}

function setAudioPlay(on) {
  state.audioPlay = !!on;
  saveViewPrefs();
  sendControl('setaudioplay', { on: state.audioPlay });
  syncSettingsUi();
  if (state.playing) audioStart();
}

function setAudioShow(on) {
  state.audioShow = !!on;
  saveViewPrefs();
  sendControl('setaudioshow', { on: state.audioShow });
  syncSettingsUi();
  rebuildView();
  paint();
}

/* -------------------------------------------------------------- 播放 */

// 当前该从哪儿起播：播放头位置 + 提前量（排到音频时钟的未来，见 AUDIO_LEAD）
function audioPlanNow() {
  if (!state.audioPlay || !state.audioAvailable) return [];
  const tempo = state.tempo;
  const rate = state.speed > 0 ? state.speed : 1;
  const fromSec = audioSecAtTick(tempo, state.playheadTick) + AUDIO_LEAD * rate;
  return audioPlan(state.audioLanes, tempo, fromSec, rate);
}

function audioStart() {
  if (!state.audioPlay || !state.audioAvailable) { audioEngine.stop(); return 0; }
  const plan = audioPlanNow();
  if (!plan.length) { audioEngine.stop(); return 0; }
  return audioEngine.play(plan, AUDIO_LEAD);
}

function audioStop() {
  audioEngine.stop();
}

/* -------------------------------------------------------------- 交互 */

let audioDrag = null;          // 正在拖的状态机（放在模块级，鼠标事件里直接读）

function startAudioDrag(hit, e) {
  const lane = state.audioLanes[hit.lane];
  const clip = lane && lane.clips[hit.clip];
  if (!clip) return;
  const tick = xToTick(state.view, contentX(e.clientX));
  audioDrag = {
    lane: hit.lane, clip: hit.clip, edge: hit.edge,
    grabTick: tick - clip.startTick,        // 抓手与片段起点的差（拖动才跟手）
    orig: Object.assign({}, clip),
    moved: false, readout: audioReadout(clip),
  };
  state.audioDrag = { lane: hit.lane, clip: hit.clip, edge: hit.edge, readout: audioReadout(clip) };
  el.canvas.style.cursor = hit.edge === 'body' ? 'grabbing' : 'ew-resize';
  window.addEventListener('mousemove', onAudioDragMove);
  window.addEventListener('mouseup', onAudioDragEnd);
  paint();
}

function onAudioDragMove(e) {
  if (!audioDrag) return;
  const lane = state.audioLanes[audioDrag.lane];
  if (!lane || !lane.clips[audioDrag.clip]) return;
  const tick = xToTick(state.view, contentX(e.clientX));
  const bypass = e.altKey;                  // 按住 Alt 临时不吸附
  const grid = audioGridTicks();
  const snapT = (t) => Math.max(0, Math.round((state.audioSnap && !bypass) ? audioSnapTick(t, grid) : t));
  const orig = audioDrag.orig;
  const dur = audioSrcDur(orig);
  let next;
  if (audioDrag.edge === 'body') {
    next = audioMoveTo(orig, snapT(tick - audioDrag.grabTick));
  } else if (audioDrag.edge === 'left') {
    next = audioTrimLeft(state.tempo, orig, snapT(tick), dur);
  } else {
    next = audioTrimRight(state.tempo, orig, snapT(tick), dur);
  }
  const same = next.startTick === lane.clips[audioDrag.clip].startTick
    && next.lengthSec === lane.clips[audioDrag.clip].lengthSec
    && next.srcOffsetSec === lane.clips[audioDrag.clip].srcOffsetSec;
  lane.clips[audioDrag.clip] = next;
  audioDrag.moved = audioDrag.moved || !same;
  state.audioDrag = {
    lane: audioDrag.lane, clip: audioDrag.clip, edge: audioDrag.edge,
    readout: audioReadout(next),
  };
  paint();
}

function onAudioDragEnd() {
  window.removeEventListener('mousemove', onAudioDragMove);
  window.removeEventListener('mouseup', onAudioDragEnd);
  el.canvas.style.cursor = '';
  const drag = audioDrag;
  audioDrag = null;
  state.audioDrag = null;
  if (!drag) return;
  const lane = state.audioLanes[drag.lane];
  const clip = lane && lane.clips[drag.clip];
  if (drag.moved && clip) afterAudioChange();
  paint();
}

function audioBarClick(key) {
  if (key === 'import') el.audioFile.click();
  else if (key === 'add') addAudioLaneAndShow();
  else if (key === 'snap') { setAudioSnap(!state.audioSnap); toast(state.audioSnap ? '吸附到拍：开' : '吸附：关（可以随便放）'); }
}

function audioHeadClick(hit) {
  if (hit.kind === 'mute') toggleAudioMute(hit.lane);
  else if (hit.kind === 'del') removeAudioLane(hit.lane);
}

// 文件拖到窗口里：提示 + 落点线 + 松手导入（拖到某条音频轨上就放那一条）
function bindAudioDrop() {
  const isFileDrag = (e) => {
    const dt = e.dataTransfer;
    if (!dt) return false;
    return [...(dt.types || [])].includes('Files');
  };
  const showHint = (on) => {
    document.body.classList.toggle('dropping', on);
    if (el.dropHint) el.dropHint.hidden = !on;
  };
  document.addEventListener('dragenter', (e) => {
    if (!isFileDrag(e)) return;
    e.preventDefault();
    showHint(true);
  });
  document.addEventListener('dragover', (e) => {
    if (!isFileDrag(e)) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = 'copy';
    if (state.view && state.view.mode === 'arrange') {
      const rect = el.canvas.getBoundingClientRect();
      const tick = audioTickAt(e.clientX, false);
      const lane = audioLaneAt(state.view, e.clientX - rect.left,
                               e.clientY - rect.top, state.scrollY);
      state.audioDrop = { tick, lane };
      paint();
    }
  });
  document.addEventListener('dragleave', (e) => {
    if (e.relatedTarget) return;            // 还在窗口里转，别闪
    state.audioDrop = null;
    showHint(false);
    paint();
  });
  document.addEventListener('drop', async (e) => {
    if (!isFileDrag(e)) return;
    e.preventDefault();
    showHint(false);
    const files = [...(e.dataTransfer.files || [])];
    const tick = e.clientX ? audioTickAt(e.clientX, false) : state.playheadTick;
    let lane;
    if (state.view && state.view.mode === 'arrange') {
      const rect = el.canvas.getBoundingClientRect();
      lane = audioLaneAt(state.view, e.clientX - rect.left, e.clientY - rect.top, state.scrollY);
    }
    state.audioDrop = null;
    await importAudioFiles(files, { tick, lane: lane >= 0 ? lane : undefined });
    paint();
  });
}



/* ------------------------------------------------ 钢琴窗下部：力度 / CC 栏 */

function ccChoices() {
  // 工程里实际有哪些 CC（契约 controllers 汇总），没有就是空数组
  const byCc = new Map();
  for (const t of (state.project && state.project.tracks) || []) {
    for (const c of t.clips || []) {
      for (const cc of c.controllers || []) {
        const cur = byCc.get(cc.cc) || { cc: cc.cc, name: cc.name || `CC${cc.cc}`, n: 0 };
        cur.n += (cc.points || []).length;
        byCc.set(cc.cc, cur);
      }
    }
  }
  return [...byCc.values()].sort((a, b) => a.cc - b.cc);
}

function laneOf(kind, cc) {
  return state.lanes.find((l) => l.kind === kind && (kind !== 'cc' || l.cc === cc)) || null;
}

function afterLaneChange() {
  saveViewPrefs();
  rebuildView();
  syncSettingsUi();
  sendControl('setlanes', { lanes: state.lanes });   // 控制器栏也照搬到别的窗口
  paint();
}

// 中继过来的控制器栏（规范化逻辑和 applyViewPrefs 里那份共用）
function setLanesFromRemote(lanes) {
  if (!Array.isArray(lanes)) return;
  state.lanes = normalizeLanes(lanes);
  afterLaneChange();
}

function addLane(patch) {
  laneSeq += 1;
  const lane = Object.assign({ id: `lane${laneSeq}`, kind: 'velocity', cc: 0 }, patch);
  if (lane.kind === 'cc' && laneOf('cc', lane.cc)) return;    // 同一个 CC 不重复加
  state.lanes.push(lane);
  afterLaneChange();
}

function removeLane(id) {
  state.lanes = state.lanes.filter((l) => l.id !== id);
  afterLaneChange();
}

function setLaneCc(id, cc) {
  const lane = state.lanes.find((l) => l.id === id);
  if (!lane) return;
  if (state.lanes.some((l) => l.id !== id && l.kind === 'cc' && l.cc === cc)) {
    toast(`CC${cc} 已经有一栏了`);
    return;
  }
  lane.cc = cc;
  afterLaneChange();
}

function setVelocityLane(on) {
  const lane = laneOf('velocity');
  if (on && !lane) addLane({ kind: 'velocity' });
  else if (!on && lane) removeLane(lane.id);
}

function setLaneHeight(v) {
  state.laneH = Math.min(LANE_H_MAX, Math.max(LANE_H_MIN, Math.round(v)));
  saveViewPrefs();
  sendControl('setlaneh', { value: state.laneH });
  syncSettingsUi();
  paint();
}

// 设置菜单里的"CC 曲线栏"编辑器：列出已加的栏（可换 CC / 删）+ 加一栏
function renderLaneEditor(ctl, refresh) {
  const choices = ccChoices();
  const ccLanes = state.lanes.filter((l) => l.kind === 'cc');

  const list = document.createElement('div');
  list.className = 'lane-list';
  if (!ccLanes.length) {
    const empty = document.createElement('span');
    empty.className = 'lane-empty';
    empty.textContent = choices.length ? '还没加 CC 栏' : '本工程没有 CC 数据';
    list.appendChild(empty);
  }
  for (const lane of ccLanes) {
    const row = document.createElement('div');
    row.className = 'lane-row';
    const sel = document.createElement('select');
    sel.className = 'lane-cc';
    for (const c of choices) {
      const o = document.createElement('option');
      o.value = String(c.cc);
      o.textContent = `CC${c.cc} ${c.name} · ${c.n} 点`;
      sel.appendChild(o);
    }
    if (!choices.some((c) => c.cc === lane.cc)) {
      const o = document.createElement('option');       // 工程里没有也保留当前选择
      o.value = String(lane.cc);
      o.textContent = `CC${lane.cc}`;
      sel.appendChild(o);
    }
    sel.value = String(lane.cc);
    sel.addEventListener('change', () => { setLaneCc(lane.id, parseInt(sel.value, 10)); });
    const del = document.createElement('button');
    del.className = 'seg lane-del';
    del.textContent = '删';
    del.title = '删掉这一栏';
    del.addEventListener('click', () => removeLane(lane.id));
    row.append(sel, del);
    list.appendChild(row);
  }
  ctl.appendChild(list);

  const add = document.createElement('button');
  add.className = 'seg lane-add';
  add.textContent = '+ 加一栏';
  add.disabled = !choices.length || ccLanes.length >= choices.length;
  add.addEventListener('click', () => {
    const free = choices.find((c) => !laneOf('cc', c.cc));
    if (free) addLane({ kind: 'cc', cc: free.cc });
    refresh();
  });
  ctl.appendChild(add);
}

/* ------------------------------------------------------------------ 交互 */

function bindUi() {
  el.scroll.addEventListener('scroll', paint, { passive: true });
  window.addEventListener('resize', () => { resizeSpacer(); paint(); });

  // 后台标签页里 rAF 会被节流（声音还在按音频时钟走），切回来时先停一次再重排
  document.addEventListener('visibilitychange', () => {
    if (!state.playing) return;
    if (document.hidden) audioEngine.stop();
    else audioStart();
  });

  el.btnPlay.addEventListener('click', () => setPlaying(!state.playing));
  el.btnHome.addEventListener('click', () => { goHome(); sendControl('home'); });
  if (el.btnAudio) el.btnAudio.addEventListener('click', () => el.audioFile.click());
  el.audioFile.addEventListener('change', async () => {
    const files = [...el.audioFile.files];
    el.audioFile.value = '';               // 同一个文件再选一次也要能触发
    await importAudioFiles(files, {});
  });
  bindAudioDrop();

  document.addEventListener('keydown', (e) => {
    const tag = (e.target && e.target.tagName) || '';
    if (tag === 'INPUT' || tag === 'SELECT' || tag === 'TEXTAREA') return;  // 别抢控件按键
    if (e.code === 'Escape') {
      if (!el.swatchPop.hidden) { closeSwatchPop(); return; }
      if (!el.trackMenu.hidden) { toggleTrackMenu(false); return; }
      if (!el.menu.hidden) { toggleMenu(false); return; }
      if (isClean()) { setClean(false); return; }
    }
    if (e.code === 'Comma') { toggleMenu(); return; }
    if (e.code === 'KeyT') { toggleTrackMenu(); return; }
    if (e.code === 'Space') { e.preventDefault(); setPlaying(!state.playing); }
    if (e.code === 'Home') { el.btnHome.click(); }
    if (e.code === 'KeyH') { setClean(!isClean()); }
    if (e.code === 'KeyE') { setExportMode(!isExport()); }
    if (e.code === 'KeyM') { setViewMode(state.viewMode === 'midi' ? 'arrange' : 'midi'); }
    if (e.code === 'KeyI') { el.audioFile.click(); }     // 导入音频
  });

  el.canvas.addEventListener('mousedown', (e) => {
    if (e.button !== 0) return;      // 右键留给下面的 contextmenu（恢复默认色）
    const rect = el.canvas.getBoundingClientRect();
    const x = e.clientX - rect.left;
    const y = e.clientY - rect.top;
    // 音频区标题条上的按钮（导入 / 加一轨 / 吸附）
    const barKey = audioBarHit(state.view, x, y, state.scrollY);
    if (barKey) { e.preventDefault(); audioBarClick(barKey); return; }
    // 音频轨头的 静音 / 删除
    const headHit = audioHeadHit(state.view, x, y, state.scrollY);
    if (headHit) { e.preventDefault(); audioHeadClick(headHit); return; }
    // 轨道头上的色卡：点它开颜色选择器，别去动播放头
    const sw = swatchTrackAt(x, y);
    if (sw >= 0) { e.preventDefault(); toggleSwatchPop(sw, e.clientX, e.clientY); return; }
    if (x < state.view.headW) return;
    closeSwatchPop();
    // 音频片段：拖中间挪位置、拖两头改长度
    const hit = audioClipAt(state.view, x, y, state.scrollY, state.scrollX, state);
    if (hit) { e.preventDefault(); startAudioDrag(hit, e); return; }
    // 点标尺/时间线定位播放头：x 要加成内容坐标（横向滚动后 else 会整块偏左）
    seekToTick(xToTick(state.view, x + state.scrollX));
    sendControl('seek', { tick: state.playheadTick });   // OBS 画面同步跳到这个位置
  });

  // 鼠标划过音频片段：画裁剪手柄 + 换光标（只在命中项变了才重画）
  el.canvas.addEventListener('mousemove', (e) => {
    if (state.audioDrag || !state.view || state.view.mode !== 'arrange') return;
    const rect = el.canvas.getBoundingClientRect();
    const hit = audioClipAt(state.view, e.clientX - rect.left, e.clientY - rect.top,
                            state.scrollY, state.scrollX, state);
    const next = hit ? { lane: hit.lane, clip: hit.clip, edge: hit.edge } : null;
    const prev = state.audioHover;
    const same = (!next && !prev) || (next && prev && next.lane === prev.lane
      && next.clip === prev.clip && next.edge === prev.edge);
    if (same) return;
    state.audioHover = next;
    el.canvas.style.cursor = next ? (next.edge === 'body' ? 'grab' : 'ew-resize') : '';
    paint();
  });

  // 右键点色卡 = 恢复默认色；右键点音频片段 / 轨道头 = 删掉它
  el.canvas.addEventListener('contextmenu', (e) => {
    const rect = el.canvas.getBoundingClientRect();
    const x = e.clientX - rect.left;
    const y = e.clientY - rect.top;
    const headHit = audioHeadHit(state.view, x, y, state.scrollY);
    if (headHit) {
      e.preventDefault();
      removeAudioLane(headHit.lane);
      return;
    }
    const clipHit = audioClipAt(state.view, x, y, state.scrollY, state.scrollX, state);
    if (clipHit) {
      e.preventDefault();
      removeAudioClip(clipHit.lane, clipHit.clip);
      return;
    }
    const vi = swatchTrackAt(x, y);
    if (vi < 0) return;
    e.preventDefault();
    const t = state.view.tracks[vi];
    const pi = typeof t.projectIndex === 'number' ? t.projectIndex : vi;
    setTrackColor(pi, null);
    toast('已恢复默认色');
  });

  document.getElementById('btn-zoom-in').addEventListener('click', () => zoom(1.35));
  document.getElementById('btn-zoom-out').addEventListener('click', () => zoom(1 / 1.35));
  document.getElementById('btn-fit').addEventListener('click', fit);

  // 显示选项（旧顶栏控件已并入设置菜单，这里只留菜单与快捷键）
  el.btnSettings.addEventListener('click', (e) => { e.stopPropagation(); toggleMenu(); });
  document.addEventListener('click', (e) => {
    // 选项点击后菜单会重渲染，事件目标已脱离 DOM —— 这种情况不算"点外面"
    if (!e.target || !e.target.isConnected) return;
    if (!el.menu.hidden && !e.target.closest('.settings')) toggleMenu(false);
    if (!el.trackMenu.hidden && !e.target.closest('.tracks-picker')) toggleTrackMenu(false);
    // 画布上的点击（含点色卡开选择器）在 mousedown 里处理，别在这儿又关掉
    if (e.target === el.canvas) return;
    if (!el.swatchPop.hidden && !e.target.closest('.swatch-pop')) closeSwatchPop();
  });

  // 轨道色卡选择器
  el.swatchPop.addEventListener('click', (e) => e.stopPropagation());
  el.swatchCustom.addEventListener('input', () => {
    const pi = swatchProjectIndex();
    if (pi >= 0) setTrackColor(pi, el.swatchCustom.value);
  });
  el.swatchReset.addEventListener('click', (e) => {
    e.stopPropagation();
    const pi = swatchProjectIndex();
    if (pi < 0) return;
    setTrackColor(pi, null);
    toast('已恢复默认色');
  });

  // 轨道显示/隐藏选择器
  el.btnTracks.addEventListener('click', (e) => { e.stopPropagation(); toggleTrackMenu(); });
  el.btnTracksAll.addEventListener('click', (e) => { e.stopPropagation(); toggleAllTracks(); });
  el.trackMenu.addEventListener('click', (e) => e.stopPropagation());
  document.getElementById('btn-grad-palette').addEventListener('click', (e) => {
    e.stopPropagation(); applyTrackGradient('palette');
  });
  document.getElementById('btn-grad-rgb').addEventListener('click', (e) => {
    e.stopPropagation(); applyTrackGradient('rgb');
  });
  document.getElementById('btn-grad-clear').addEventListener('click', (e) => {
    e.stopPropagation(); clearVisibleTrackColors();
  });

  // 滚轮：默认上下浏览轨道；Shift 横向；Ctrl 时间缩放；Alt 行高缩放
  el.scroll.addEventListener('wheel', (e) => {
    if (e.ctrlKey || e.metaKey) {
      e.preventDefault();
      zoomAt(e.clientX, wheelFactor(e.deltaY));
    } else if (e.altKey) {
      e.preventDefault();
      zoomRows(wheelFactor(e.deltaY), e.clientY);
    } else if (e.shiftKey) {
      e.preventDefault();
      el.scroll.scrollLeft += e.deltaY;
    }
  }, { passive: false });
}

// 滚轮一格大约 100px（行模式约 3 行），统一成温和的缩放倍率
function wheelFactor(deltaY) {
  return Math.exp(-Math.max(-120, Math.min(120, deltaY)) * 0.0018);
}

/* ------------------------------------------------------------ 显示选项 */

function isClean() {
  return !state.showChrome;
}

function setClean(on) {
  state.showChrome = !on;
  state.showHeads = !on;
  document.body.classList.toggle('clean', on);
  applyHeads();
  saveViewPrefs();
  sendControl('setclean', { on: !!on });
  if (on) toast('干净模式：按 H 或 Esc 退出');
  paint();
}

/* ------------------------------------------- 导出模式（截图 / 叠层编辑用） */

// 一键隐藏"背景格线 + 上方标尺 + 滚动条"：导出干净的底图，拿去叠层编辑。
// 和干净模式互不依赖 —— 两个都开就是只剩内容（顶栏/轨道头/状态栏也没了）。
function isExport() {
  return state.exportMode;
}

function setExportMode(on) {
  state.exportMode = !!on;
  document.body.classList.toggle('export', state.exportMode);
  setCanvasExportMode(state.exportMode);   // timeline.js：标尺高度 0 + 不画网格线
  rebuildView();                           // 标尺没了，内容高度跟着变
  saveViewPrefs();
  sendControl('setexport', { on: state.exportMode });
  syncSettingsUi();
  paint();
  if (state.exportMode) toast('导出模式：网格 / 标尺 / 滚动条已隐藏（快捷键 E）');
}

// 名栏宽度变化时补偿横向滚动，画面里的内容不会跳
function applyHeads() {
  const before = state.view ? state.view.headW : (state.showHeads ? HEAD_W : 0);
  rebuildView();
  const delta = state.view.headW - before;
  if (delta) el.scroll.scrollLeft = Math.max(0, el.scroll.scrollLeft + delta);
  // 轨道栏关掉时，钉在表头格上的轨道选择器没地方放
  document.body.classList.toggle('no-heads', !state.showHeads);
  if (!state.showHeads) { toggleTrackMenu(false); closeSwatchPop(); }
}

function setClipNames(on) {
  state.showClipNames = !!on;
  saveViewPrefs();
  sendControl('setclipnames', { on: state.showClipNames });
  syncSettingsUi();
  paint();
}

function setFollowMode(mode) {
  state.followMode = mode === 'center' ? 'center' : 'page';
  saveViewPrefs();
  sendControl('setfollow', { mode: state.followMode });
  syncSettingsUi();
}

function setHeads(show) {
  state.showHeads = !!show;
  applyHeads();
  saveViewPrefs();
  sendControl('setheads', { on: state.showHeads });
  syncSettingsUi();
  paint();
}

function setRowHeight(v) {
  state.rowH = Math.min(ROW_H_MAX, Math.max(ROW_H_MIN, v));
  rebuildView();
  saveViewPrefs();
  sendControl('setrowh', { value: state.rowH });
  syncSettingsUi();
  paint();
}

function setSemiHeight(v) {
  state.semiH = Math.min(SEMI_H_MAX, Math.max(SEMI_H_MIN, v));
  if (state.view.mode === 'midi') rebuildView();
  saveViewPrefs();
  sendControl('setsemih', { value: state.semiH });
  syncSettingsUi();
  paint();
}

function setSpeed(v) {
  const changed = state.speed !== v;
  state.speed = v;
  saveViewPrefs();
  sendControl('setspeed', { value: v });
  syncSettingsUi();
  // 播放中改速度：音频按新速率重排（慢了声音也慢，和宿主里一样）
  if (changed && state.playing) audioStart();
}

function setFx(patch) {
  Object.assign(state.fx, patch);
  saveViewPrefs();
  sendControl('setfx', { patch });
  syncSettingsUi();
  paint();
}

/* ------------------------------------------------------ 设置菜单（二级） */

// 一级 = 分组，二级 = 组内选项。所有选项在这里声明，UI 自动生成。
const SETTINGS_SPEC = [
  { key: 'display', label: '显示', items: [
    { id: 'opt-clean', type: 'check', label: '干净模式', hint: '隐藏顶栏 / 轨道头 / 状态栏（快捷键 H）',
      get: () => isClean(), set: (v) => setClean(v) },
    { id: 'opt-export', type: 'check', label: '导出模式',
      hint: '隐藏背景格线 / 上方标尺 / 滚动条，截图叠层用（快捷键 E；和干净模式可叠加）',
      get: () => isExport(), set: (v) => setExportMode(v) },
    { id: 'opt-clipnames', type: 'check', label: '片段上显示名称',
      get: () => state.showClipNames, set: (v) => setClipNames(v) },
    { id: 'opt-heads', type: 'check', label: '轨道头 / 钢琴键栏',
      get: () => state.showHeads, set: (v) => setHeads(v) },
    { id: 'opt-rowh', type: 'num', label: '走带行高', min: ROW_H_MIN, max: ROW_H_MAX, step: 4, unit: 'px',
      hint: 'Alt+滚轮也可以', get: () => Math.round(state.rowH), set: (v) => setRowHeight(v) },
    { id: 'opt-semih', type: 'num', label: '钢琴窗半音行高', min: SEMI_H_MIN, max: SEMI_H_MAX, step: 2, unit: 'px',
      get: () => Math.round(state.semiH), set: (v) => setSemiHeight(v) },
  ]},
  { key: 'view', label: '视图', items: [
    { id: 'opt-viewmode', type: 'seg', label: '视图模式', options: [['arrange', '走带'], ['midi', '钢琴窗']],
      hint: '钢琴窗只显示工程里的 MIDI 音符', get: () => state.viewMode, set: (v) => setViewMode(v) },
    { id: 'opt-follow', type: 'seg', label: '播放跟随', options: [['page', '翻页'], ['center', '居中']],
      hint: '居中 = 播放头钉在时间线正中连续滚动', get: () => state.followMode, set: (v) => setFollowMode(v) },
  ]},
  { key: 'play', label: '播放', items: [
    { id: 'opt-speed', type: 'seg', label: '播放速度', options: [['0.5', '0.5x'], ['1', '1x'], ['1.5', '1.5x'], ['2', '2x']],
      get: () => String(state.speed), set: (v) => setSpeed(parseFloat(v)) },
  ]},
  { key: 'lanes', label: '控制器', items: [
    { id: 'opt-lane-vel', type: 'check', label: '力度栏',
      hint: '钢琴窗视图下部：每个音符一根柱（只在钢琴窗里显示）',
      get: () => !!laneOf('velocity'), set: (v) => setVelocityLane(v) },
    { id: 'opt-lane-cc', type: 'custom', label: 'CC 曲线栏', render: renderLaneEditor },
    { id: 'opt-lane-h', type: 'num', label: '单栏高度', min: LANE_H_MIN, max: LANE_H_MAX, step: 8, unit: 'px',
      get: () => Math.round(state.laneH), set: (v) => setLaneHeight(v) },
  ]},
  { key: 'audio', label: '音频', items: [
    { id: 'opt-audio-import', type: 'custom', label: '导入音频', render: renderAudioImport },
    { id: 'opt-audio-lane', type: 'custom', label: '音频轨', render: renderAudioLaneButtons },
    { id: 'opt-audio-snap', type: 'check', label: '拖动吸附到拍',
      hint: '拖音频时吸到最近的拍，方便对齐小节（按住 Alt 临时不吸）',
      get: () => state.audioSnap, set: (v) => setAudioSnap(v) },
    { id: 'opt-audio-play', type: 'check', label: '播放音频',
      hint: '跟着走带一起出声（按播放速度变速，和宿主里的磁带式变速一样）',
      get: () => state.audioPlay, set: (v) => setAudioPlay(v) },
    { id: 'opt-audio-show', type: 'check', label: '显示音频区',
      hint: '临时藏起来看工程，数据还在（快捷键 I 导入）',
      get: () => state.audioShow, set: (v) => setAudioShow(v) },
    { id: 'opt-audio-dir', type: 'custom', label: '存放位置', render: renderAudioDir },
  ]},
  { key: 'fx', label: '动效', items: [
    { id: 'opt-fxon', type: 'check', label: '启用播放动效', hint: '播放头扫过时给音符 / 片段加光效',
      get: () => state.fx.on, set: (v) => setFx({ on: v }) },
    { id: 'opt-fxnote', type: 'check', label: '音符闪光',
      get: () => state.fx.note, set: (v) => setFx({ note: v }), disabled: () => !state.fx.on },
    { id: 'opt-fxclip', type: 'check', label: '片段入点光晕',
      get: () => state.fx.clip, set: (v) => setFx({ clip: v }), disabled: () => !state.fx.on },
    { id: 'opt-fxhead', type: 'check', label: '播放头拖尾',
      get: () => state.fx.head, set: (v) => setFx({ head: v }), disabled: () => !state.fx.on },
    { id: 'opt-fxstrength', type: 'seg', label: '强度', options: [['0.6', '柔和'], ['1', '标准'], ['1.6', '强烈']],
      get: () => String(state.fx.strength), set: (v) => setFx({ strength: parseFloat(v) }), disabled: () => !state.fx.on },
    { id: 'opt-fxdecay', type: 'seg', label: '余韵', options: [['220', '短'], ['420', '中'], ['800', '长']],
      get: () => String(state.fx.decay), set: (v) => setFx({ decay: parseInt(v, 10) }), disabled: () => !state.fx.on },
  ]},
  { key: 'theme', label: '配色', items: [
    { id: 'theme-select', type: 'select', label: '主题',
      options: { groups: themeOptions() },
      get: () => themeName, set: (v) => setTheme(v) },
    { id: 'accent-pick', type: 'color', label: '主色',
      get: () => readVar('--accent') || '#3389d1', set: (v) => setAccent(v) },
  ]},
];

let activeGroup = 0;

function toggleMenu(force) {
  const open = force === undefined ? el.menu.hidden : force;
  el.menu.hidden = !open;
  el.btnSettings.classList.toggle('on', open);
  if (open) renderMenu();
}

function renderMenu() {
  el.menuGroups.textContent = '';
  SETTINGS_SPEC.forEach((g, i) => {
    const b = document.createElement('button');
    b.className = 'grp' + (i === activeGroup ? ' on' : '');
    b.textContent = g.label;
    b.addEventListener('click', () => { activeGroup = i; renderMenu(); });
    el.menuGroups.appendChild(b);
  });

  // 所有分组的二级面板都建出来、只显示当前分组 ——
  // 这样每个选项元素始终在 DOM 里（脚本/自动化随时能取到）
  el.menuPane.textContent = '';
  SETTINGS_SPEC.forEach((g, i) => {
    const pane = document.createElement('div');
    pane.className = 'pane' + (i === activeGroup ? ' on' : '');
    pane.dataset.group = g.key;
    for (const item of g.items) pane.appendChild(renderSettingRow(item));
    el.menuPane.appendChild(pane);
  });
}

function renderSettingRow(item) {
  const off = !!(item.disabled && item.disabled());
  const row = document.createElement('div');
  row.className = 'row' + (off ? ' off' : '');

  const label = document.createElement('span');
  label.className = 'row-label';
  label.textContent = item.label;
  if (item.hint) label.title = item.hint;
  row.appendChild(label);

  const ctl = document.createElement('span');
  ctl.className = 'row-ctl';
  const refresh = () => { syncSettingsUi(); paint(); };

  if (item.type === 'check') {
    const cb = document.createElement('input');
    cb.type = 'checkbox';
    cb.id = item.id;
    cb.checked = !!item.get();
    cb.disabled = off;
    cb.addEventListener('change', () => { item.set(cb.checked); refresh(); });
    ctl.appendChild(cb);
  } else if (item.type === 'seg') {
    for (const [v, lab] of item.options) {
      const b = document.createElement('button');
      b.className = 'seg' + (String(item.get()) === String(v) ? ' on' : '');
      b.textContent = lab;
      b.disabled = off;
      b.dataset.item = item.id;
      b.dataset.value = v;
      b.addEventListener('click', () => { item.set(v); refresh(); });
      ctl.appendChild(b);
    }
  } else if (item.type === 'num') {
    const mk = (txt, delta) => {
      const b = document.createElement('button');
      b.className = 'seg';
      b.textContent = txt;
      b.disabled = off || (delta < 0 ? item.get() <= item.min : item.get() >= item.max);
      b.addEventListener('click', () => { item.set(item.get() + delta); refresh(); });
      return b;
    };
    const val = document.createElement('span');
    val.className = 'num';
    val.id = item.id;
    val.textContent = item.get() + (item.unit || '');
    ctl.append(mk('−', -item.step), val, mk('+', item.step));
  } else if (item.type === 'select') {
    const s = document.createElement('select');
    s.id = item.id;
    // options 两种写法：[[值, 显示名], ...] 或 { groups: [{ label, options: [...] }] }
    const addOpt = (parent, v, lab) => {
      const o = document.createElement('option');
      o.value = v;
      o.textContent = lab;
      parent.appendChild(o);
    };
    if (Array.isArray(item.options)) {
      for (const [v, lab] of item.options) addOpt(s, v, lab);
    } else {
      for (const g of item.options.groups || []) {
        const og = document.createElement('optgroup');
        og.label = g.label;
        for (const [v, lab] of g.options) addOpt(og, v, lab);
        s.appendChild(og);
      }
    }
    s.value = item.get();
    s.disabled = off;
    s.addEventListener('change', () => { item.set(s.value); refresh(); });
    ctl.appendChild(s);
  } else if (item.type === 'custom') {
    item.render(ctl, refresh);
  } else if (item.type === 'color') {
    const c = document.createElement('input');
    c.type = 'color';
    c.id = item.id;
    c.value = item.get();
    c.disabled = off;
    c.addEventListener('input', () => { item.set(c.value); paint(); });
    ctl.appendChild(c);
  }

  row.appendChild(ctl);
  return row;
}

// 外部改了状态（快捷键 / 滚轮 / 代码）后，菜单里的勾选态跟着刷新
function syncSettingsUi() {
  if (!el.menu.hidden) renderMenu();
  if (!el.trackMenu.hidden) renderTrackMenu();
}

/* ------------------------------------------- 设置菜单里的音频区编辑器 */

function renderAudioImport(ctl) {
  const b = document.createElement('button');
  b.className = 'seg';
  b.id = 'btn-audio-import';
  b.textContent = '选文件…';
  b.disabled = !state.audioAvailable;
  b.title = state.audioAvailable
    ? '支持 mp3 / wav / ogg / flac / m4a 等（也可直接把文件拖到画布上）'
    : '音频轨要连本地服务才有：用 run.bat / python -m dawview 打开';
  b.addEventListener('click', () => el.audioFile.click());
  ctl.appendChild(b);
}

function renderAudioLaneButtons(ctl) {
  const add = document.createElement('button');
  add.className = 'seg';
  add.id = 'btn-audio-add';
  add.textContent = '+ 加一轨';
  add.disabled = !state.audioAvailable;
  add.addEventListener('click', () => addAudioLaneAndShow());
  ctl.appendChild(add);
  const n = state.audioLanes.length;
  const info = document.createElement('span');
  info.className = 'lane-empty';
  info.id = 'audio-lane-count';
  info.textContent = n ? `${n} 条 · ${state.audioLanes.reduce((a, l) => a + l.clips.length, 0)} 段` : '还没有音频轨';
  ctl.appendChild(info);
}

function renderAudioDir(ctl) {
  const s = document.createElement('span');
  s.className = 'lane-empty';
  s.id = 'audio-dir-label';
  s.textContent = state.audioAvailable
    ? (state.audioWritable ? state.audioDir : `${state.audioDir}（写不进去：只在本窗口有效）`)
    : '（没连本地服务）';
  s.title = s.textContent;
  ctl.appendChild(s);
}

/* ------------------------------------------------------------ 轨道颜色 */

// 色卡调色板：深浅主题下都能看清的 12 色
const SWATCH_PALETTE = [
  '#3389d1', '#4fb3a6', '#8b7cf6', '#e2705f', '#d9a04f', '#5fa87a',
  '#e06fa8', '#5b7cfa', '#c9a15a', '#f0876b', '#7cc4f5', '#9ed4b3',
];

const COLORS_KEY = 'dawview.trackColors';
const HEX_RE = /^#[0-9a-f]{6}$/i;

// 颜色按"工程"分桶存：换个工程不会串色
function colorBucketKey() {
  const meta = (state.project && state.project.meta) || {};
  return meta.projectName || '未命名';
}

function loadTrackColors() {
  state.trackColors = {};
  try {
    const all = JSON.parse(localStorage.getItem(COLORS_KEY) || '{}');
    const bucket = all[colorBucketKey()] || {};
    for (const [k, v] of Object.entries(bucket)) {
      const i = parseInt(k, 10);
      if (Number.isInteger(i) && i >= 0 && HEX_RE.test(v)) state.trackColors[i] = String(v).toLowerCase();
    }
  } catch (e) { /* 隐私模式 / 坏数据都当没有 */ }
}

function saveTrackColors() {
  try {
    const all = JSON.parse(localStorage.getItem(COLORS_KEY) || '{}');
    const bucket = {};
    for (const [k, v] of Object.entries(state.trackColors)) bucket[k] = v;
    if (Object.keys(bucket).length) all[colorBucketKey()] = bucket;
    else delete all[colorBucketKey()];
    localStorage.setItem(COLORS_KEY, JSON.stringify(all));
  } catch (e) { /* 忽略 */ }
  pushPrefs();          // 轨道配色也同步给别的窗口
}

// 自定色，'' = 没自定（跟随主题默认色）
function trackColorHex(projectIndex) {
  return state.trackColors[projectIndex] || '';
}

// hex = null / '' → 恢复默认
function setTrackColor(projectIndex, hex) {
  if (hex && HEX_RE.test(hex)) state.trackColors[projectIndex] = hex.toLowerCase();
  else delete state.trackColors[projectIndex];
  saveTrackColors();
  renderTrackMenu();      // 选择器里的小色点跟着变
  renderSwatchPop();
  paint();
}

// 画布坐标 -> 轨道下标（色卡热区），没命中返回 -1
function swatchTrackAt(x, y) {
  // 必须带 scrollY：色卡热区和绘制共用"已减纵向滚动量"的画布坐标
  return hitTrackSwatch(state.view, x, y, state.scrollY);
}

function swatchProjectIndex() {
  const vi = state.swatchTrack;
  const t = state.view && vi >= 0 ? state.view.tracks[vi] : null;
  if (!t) return -1;
  return typeof t.projectIndex === 'number' ? t.projectIndex : vi;
}

function toggleSwatchPop(vi, clientX, clientY) {
  if (vi === undefined || vi < 0) { closeSwatchPop(); return; }
  if (!el.swatchPop.hidden && state.swatchTrack === vi) { closeSwatchPop(); return; }
  openSwatchPop(vi, clientX, clientY);
}

function openSwatchPop(vi, clientX, clientY) {
  state.swatchTrack = vi;
  el.swatchPop.hidden = false;
  renderSwatchPop();
  // 贴在色卡旁边，并夹在窗口内（不跑出视口）
  const r = el.swatchPop.getBoundingClientRect();
  const x = Math.max(8, Math.min(window.innerWidth - r.width - 8, (clientX || 0) + 14));
  const y = Math.max(8, Math.min(window.innerHeight - r.height - 8, (clientY || 0) - 12));
  el.swatchPop.style.left = Math.round(x) + 'px';
  el.swatchPop.style.top = Math.round(y) + 'px';
}

function closeSwatchPop() {
  el.swatchPop.hidden = true;
  state.swatchTrack = -1;
}

// 选择器内容：标题（轨道名 + 当前色）+ 调色板 + 自定义 + 默认
function renderSwatchPop() {
  const vi = state.swatchTrack;
  if (vi < 0 || el.swatchPop.hidden) return;
  const view = state.view;
  const t = view && view.tracks ? view.tracks[vi] : null;
  if (!t) { closeSwatchPop(); return; }
  const pi = typeof t.projectIndex === 'number' ? t.projectIndex : vi;
  const cur = trackColorHex(pi);

  el.swatchName.textContent = (t.name || '(未命名)') + (cur ? '' : ' · 默认色');
  el.swatchDot.style.background = cur || readVar('--clip-midi') || '#3389d1';

  el.swatchGrid.textContent = '';
  for (const hex of SWATCH_PALETTE) {
    const b = document.createElement('button');
    b.type = 'button';
    b.dataset.hex = hex;
    b.title = hex;
    b.style.background = hex;
    if (cur && cur === hex) b.classList.add('on');
    b.addEventListener('click', (e) => { e.stopPropagation(); setTrackColor(pi, hex); });
    el.swatchGrid.appendChild(b);
  }
  if (cur) el.swatchCustom.value = cur;
}

/* ------------------------------------------------------- 轨道显示/隐藏 */

const TRACK_KIND = {
  instrument: '乐器', midi: 'MIDI', audio: '音频', folder: '文件夹',
  marker: '标记', tempo: '速度', chord: '和弦',
  automation: '自动化', other: '其他',
};

function visibleTrackCount() {
  return state.project.tracks.length - state.hiddenTracks.size;
}

function toggleTrackMenu(force) {
  const open = force === undefined ? el.trackMenu.hidden : force;
  el.trackMenu.hidden = !open;
  el.btnTracks.classList.toggle('on', open);
  if (open) renderTrackMenu();
}

function renderTrackMenu() {
  const tracks = state.project.tracks || [];
  el.trackMenuCount.textContent = `显示 ${visibleTrackCount()} / ${tracks.length} 条轨道`;
  el.btnTracksAll.textContent = state.hiddenTracks.size === 0 ? '全不选' : '全选';
  renderTrackKindFilter();
  el.trackMenuList.textContent = '';
  tracks.forEach((t, i) => {
    const off = state.hiddenTracks.has(i);
    const row = document.createElement('label');
    row.className = 'track-row' + (off ? ' off' : '');
    row.dataset.index = String(i);
    const cb = document.createElement('input');
    cb.type = 'checkbox';
    cb.checked = !off;
    cb.dataset.track = String(i);
    cb.addEventListener('change', () => setTrackVisible(i, cb.checked));
    const name = document.createElement('span');
    name.className = 'tn';
    name.textContent = t.name || '(未命名)';
    name.title = name.textContent;
    // 小色点：这条轨道当前的颜色（自定色实心，没自定就半透明 = 跟主题）
    const hex = trackColorHex(i);
    const dot = document.createElement('span');
    dot.className = 'sw';
    dot.dataset.sw = String(i);
    dot.style.background = hex || readVar('--clip-midi') || '#3389d1';
    dot.style.opacity = hex ? '1' : '.45';
    dot.title = hex ? `轨道颜色 ${hex}` : '跟随主题默认色';
    const kind = document.createElement('span');
    kind.className = 'tk';
    kind.textContent = TRACK_KIND[t.kind] || t.kind || '';
    row.append(cb, dot, name, kind);
    el.trackMenuList.appendChild(row);
  });
}

function setTrackVisible(i, visible) {
  if (visible) state.hiddenTracks.delete(i);
  else state.hiddenTracks.add(i);
  state.kindFilter = '';      // 手动改了就不算"按种类筛选"了
  applyTrackFilter();
}

function toggleAllTracks() {
  const n = state.project.tracks.length;
  if (state.hiddenTracks.size === 0) {
    for (let i = 0; i < n; i++) state.hiddenTracks.add(i);
  } else {
    state.hiddenTracks.clear();
  }
  state.kindFilter = '';
  applyTrackFilter();
}

function applyTrackFilter() {
  saveViewPrefs();
  state.hits = [];
  rebuildView();
  updateStatusLine();
  renderTrackMenu();
  sendControl('sethidden', { hidden: [...state.hiddenTracks] });   // 显示 / 隐藏照搬
  paint();
}

// 中继过来的轨道显示状态（拿的是对方算好的下标集合，不会因为筛选规则不同而分叉）
function setHiddenFromRemote(list) {
  if (!Array.isArray(list)) return;
  const n = state.project ? state.project.tracks.length : 0;
  state.hiddenTracks = new Set(list.filter((i) => Number.isInteger(i) && i >= 0 && i < n));
  applyTrackFilter();
}

/* ------------------------------------------------ 轨道种类筛选 + 渐变上色 */

// 筛选条里轨道种类的固定顺序（工程里没有的种类不显示按钮）
const KIND_ORDER = ['midi', 'audio', 'automation', 'instrument', 'other',
                    'folder', 'marker', 'tempo', 'chord'];

function kindOf(t) {
  return (t && t.kind) || 'other';
}

function trackKindCounts() {
  const counts = {};
  for (const t of state.project.tracks || []) {
    const k = kindOf(t);
    counts[k] = (counts[k] || 0) + 1;
  }
  return counts;
}

// 一键只看某一类轨道（'' = 全部）。走的是同一套 hiddenTracks，
// 所以钢琴窗、状态栏、持久化都自动跟着走。
function filterByKind(kind) {
  state.kindFilter = kind || '';
  state.hiddenTracks.clear();
  if (state.kindFilter) {
    (state.project.tracks || []).forEach((t, i) => {
      if (kindOf(t) !== state.kindFilter) state.hiddenTracks.add(i);
    });
  }
  applyTrackFilter();
}

function renderTrackKindFilter() {
  if (!el.trackMenuFilter) return;
  const counts = trackKindCounts();
  const total = (state.project.tracks || []).length;
  const items = [['', `全部 ${total}`]];
  for (const k of KIND_ORDER) if (counts[k]) items.push([k, `${TRACK_KIND[k] || k} ${counts[k]}`]);
  // 契约里冒出新种类也别让它没按钮可点
  for (const k of Object.keys(counts)) {
    if (!KIND_ORDER.includes(k)) items.push([k, `${TRACK_KIND[k] || k} ${counts[k]}`]);
  }
  el.trackMenuFilter.textContent = '';
  for (const [k, label] of items) {
    const b = document.createElement('button');
    b.className = 'kind-chip' + (state.kindFilter === k ? ' on' : '');
    b.dataset.kind = k;
    b.textContent = label;
    b.title = k ? `只看${TRACK_KIND[k] || k}轨道` : '显示全部轨道';
    b.addEventListener('click', (e) => { e.stopPropagation(); filterByKind(k); });
    el.trackMenuFilter.appendChild(b);
  }
}

/* ---- 渐变上色 ---- */

function hexToRgb(hex) {
  const s = String(hex || '').replace('#', '');
  const n = parseInt(s.length === 3 ? s.replace(/(.)/g, '$1$1') : s, 16);
  if (!isFinite(n)) return { r: 0, g: 0, b: 0 };
  return { r: (n >> 16) & 255, g: (n >> 8) & 255, b: n & 255 };
}

// 返回 [h(0-360), s(0-1), l(0-1)]
function rgbToHsl(r, g, b) {
  r /= 255; g /= 255; b /= 255;
  const mx = Math.max(r, g, b), mn = Math.min(r, g, b), d = mx - mn;
  let h = 0;
  if (d) {
    if (mx === r) h = ((g - b) / d) % 6;
    else if (mx === g) h = (b - r) / d + 2;
    else h = (r - g) / d + 4;
    h *= 60;
    if (h < 0) h += 360;
  }
  const l = (mx + mn) / 2;
  const s = d ? d / (1 - Math.abs(2 * l - 1)) : 0;
  return [h, s, l];
}

function hslToHex(h, s, l) {
  h = ((h % 360) + 360) % 360;
  const c = (1 - Math.abs(2 * l - 1)) * s;
  const x = c * (1 - Math.abs(((h / 60) % 2) - 1));
  const m = l - c / 2;
  let rgb;
  if (h < 60) rgb = [c, x, 0];
  else if (h < 120) rgb = [x, c, 0];
  else if (h < 180) rgb = [0, c, x];
  else if (h < 240) rgb = [0, x, c];
  else if (h < 300) rgb = [x, 0, c];
  else rgb = [c, 0, x];
  const to = (v) => Math.round((v + m) * 255).toString(16).padStart(2, '0');
  return '#' + to(rgb[0]) + to(rgb[1]) + to(rgb[2]);
}

// 主题是深是浅：看 --bg 的相对亮度，决定渐变色的明度往哪边调
function themeIsDark() {
  const { r, g, b } = hexToRgb(readVar('--bg') || '#101418');
  return (0.2126 * r + 0.7152 * g + 0.0722 * b) < 128;
}

// 沿一组 HSL 色标等距取 n 个颜色（色相跨 0° 走最短弧，插出来才是顺的）
function sampleRamp(stops, n) {
  const out = [];
  for (let i = 0; i < n; i++) {
    const t = n > 1 ? (i / (n - 1)) * (stops.length - 1) : 0;
    const i0 = Math.min(stops.length - 1, Math.floor(t));
    const i1 = Math.min(stops.length - 1, i0 + 1);
    const f = t - i0;
    const a = stops[i0], b2 = stops[i1];
    let dh = b2.h - a.h;
    if (dh > 180) dh -= 360;            // 最短弧
    if (dh < -180) dh += 360;
    out.push(hslToHex(a.h + dh * f, a.s + (b2.s - a.s) * f, a.l + (b2.l - a.l) * f));
  }
  return out;
}

// 色卡渐变：拿调色板当色标（按色相排一遍再插值 —— 直接照原顺序插会跳色）。
// 调色板里有几个高饱和的（#5b7cfa 饱和度 0.94），插值前先把饱和度压到 0.5 以内：
// 轨道色是背景信息，饱和度太高会盖过片段本身，也不是这套主题的路线。
const GRAD_S_MAX = 0.5;

function gradientFromPalette(n) {
  const stops = SWATCH_PALETTE.map((hex) => {
    const { r, g, b } = hexToRgb(hex);
    const [h, s, l] = rgbToHsl(r, g, b);
    return { h, s: Math.min(s, GRAD_S_MAX), l };
  }).sort((a, b) => a.h - b.h);
  return sampleRamp(stops, n);
}

// RGB 渐变：色相环扫一遍，低饱和 + 按主题明暗取明度，和 12 套主题同一路线
function gradientFromHue(n) {
  const dark = themeIsDark();
  const s = dark ? 0.42 : 0.34;         // 低饱和：轨道色是背景信息，不该比片段抢眼
  const l = dark ? 0.62 : 0.42;         // 深色主题提亮、浅色主题压暗，都保证压在底色上看得清
  const out = [];
  for (let i = 0; i < n; i++) {
    const t = n > 1 ? i / (n - 1) : 0;
    out.push(hslToHex(210 + 300 * t, s, l));   // 300° 而不是 360°：首尾太像就白分了
  }
  return out;
}

// 给"当前显示的轨道"按走带从上到下的顺序排一条渐变
function applyTrackGradient(mode) {
  const list = (state.view && state.view.tracks) || [];
  if (!list.length) { toast('没有显示的轨道'); return []; }
  const colors = mode === 'rgb' ? gradientFromHue(list.length) : gradientFromPalette(list.length);
  list.forEach((t, k) => {
    const pi = Number.isInteger(t.projectIndex) ? t.projectIndex : k;
    state.trackColors[pi] = colors[k];
  });
  saveTrackColors();
  renderTrackMenu();
  renderSwatchPop();
  paint();
  toast(`${list.length} 条轨道已按${mode === 'rgb' ? 'RGB' : '色卡'}渐变上色`);
  return colors;
}

// 清除"当前显示轨道"的自定色（恢复跟随主题）
function clearVisibleTrackColors() {
  const list = (state.view && state.view.tracks) || [];
  let n = 0;
  for (const t of list) {
    const pi = Number.isInteger(t.projectIndex) ? t.projectIndex : -1;
    if (pi >= 0 && state.trackColors[pi]) { delete state.trackColors[pi]; n++; }
  }
  saveTrackColors();
  renderTrackMenu();
  renderSwatchPop();
  paint();
  toast(n ? `已清除 ${n} 条轨道的自定色` : '这些轨道本来就没自定色');
  return n;
}

// Ctrl+滚轮：以鼠标所指的 tick 为锚点做时间缩放
function zoomAt(clientX, factor) {
  const rect = el.scroll.getBoundingClientRect();
  const viewX = clientX - rect.left;
  const anchorTick = xToTick(state.view, viewX + state.scrollX);
  state.pxPerTick = Math.min(2.0, Math.max(0.002, state.pxPerTick * factor));
  rebuildView();
  el.scroll.scrollLeft = Math.max(0, tickToX(state.view, anchorTick) - viewX);
  el.zoomLabel.textContent = Math.round(state.pxPerTick / 0.04 * 100) + '%';
  saveViewPrefs();
  // 中继时把锚点按"视口宽度的比例"传过去：两个窗口宽度可能不一样
  sendControl('zoomto', {
    pxPerTick: state.pxPerTick,
    anchorTick,
    anchorFrac: viewX / Math.max(1, el.scroll.clientWidth),
  });
  paint();
}

// 中继过来的缩放：同一个 tick 落在视口里同样的相对位置上
function applyZoomTo(p) {
  if (!isFinite(p.pxPerTick)) return;
  state.pxPerTick = Math.min(2.0, Math.max(0.002, p.pxPerTick));
  rebuildView();
  const frac = isFinite(p.anchorFrac) ? Math.min(1, Math.max(0, p.anchorFrac)) : 0.5;
  const anchorX = tickToX(state.view, isFinite(p.anchorTick) ? p.anchorTick : 0);
  el.scroll.scrollLeft = Math.max(0, anchorX - el.scroll.clientWidth * frac);
  el.zoomLabel.textContent = Math.round(state.pxPerTick / 0.04 * 100) + '%';
  paint();
}

// Alt+滚轮：改行高（钢琴窗改半音行高），鼠标下的那一行保持不动
function zoomRows(factor, clientY) {
  const midi = state.view.mode === 'midi';
  const rect = el.scroll.getBoundingClientRect();
  const viewY = clientY === undefined ? el.scroll.clientHeight / 2 : clientY - rect.top;
  const cur = midi ? state.semiH : state.rowH;
  const cy = viewY + state.scrollY;
  // 鼠标压在哪个区：音频区（标题条之后）还是工程轨道区 —— 两段的行顶基准不同
  const inAudio = !midi && cy < audioRowsBottom(state.view);
  const base = midi ? getRulerH() : (inAudio ? rulerH + audioBarH(state.view) : audioRowsBottom(state.view));
  const rowIdx = (cy - base) / cur;
  const next = midi
    ? Math.min(SEMI_H_MAX, Math.max(SEMI_H_MIN, cur * factor))
    : Math.min(ROW_H_MAX, Math.max(ROW_H_MIN, cur * factor));
  if (Math.abs(next - cur) < 0.01) return;
  if (midi) state.semiH = next; else state.rowH = next;
  rebuildView();
  const baseNew = midi ? getRulerH()
    : (inAudio ? rulerH + audioBarH(state.view) : audioRowsBottom(state.view));
  el.scroll.scrollTop = Math.max(0, baseNew + rowIdx * next - viewY);
  saveViewPrefs();
  sendControl(midi ? 'setsemih' : 'setrowh', { value: next });
  paint();
}

// 走带 / 钢琴窗切换
function setViewMode(mode) {
  const next = mode === 'midi' ? 'midi' : 'arrange';
  if (next === state.viewMode) return;
  state.viewMode = next;
  state.hits = [];
  const headBefore = state.view.headW;
  rebuildView();
  const delta = state.view.headW - headBefore;
  if (delta) el.scroll.scrollLeft = Math.max(0, el.scroll.scrollLeft + delta);
  el.scroll.scrollTop = 0;
  if (next === 'midi') centerOnNoteRange();
  updateStatusLine();
  syncSettingsUi();
  saveViewPrefs();
  sendControl('setviewmode', { mode: next });
  paint();
}

// 钢琴窗是全部 128 个琴键，一屏看不完 —— 进去时先把视野滚到音符所在的音区
function centerOnNoteRange() {
  const v = state.view;
  if (v.mode !== 'midi') return;
  const mid = ((v.noteLo === undefined ? 60 : v.noteLo) + (v.noteHi === undefined ? 60 : v.noteHi)) / 2;
  const y = getRulerH() + (v.pitchHi - mid) * v.semiH - el.scroll.clientHeight / 2;
  el.scroll.scrollTop = Math.max(0, y);
  state.scrollY = el.scroll.scrollTop;
}

function zoom(factor) {
  const headW = state.view.headW;
  const anchorTick = xToTick(state.view, headW + 120);
  state.pxPerTick = Math.min(2.0, Math.max(0.002, state.pxPerTick * factor));
  rebuildView();
  el.scroll.scrollLeft = Math.max(0, tickToX(state.view, anchorTick) - headW - 120);
  el.zoomLabel.textContent = Math.round(state.pxPerTick / 0.04 * 100) + '%';
  saveViewPrefs();
  sendControl('zoom', { factor });     // 中继：对方按同样的倍率缩放
  paint();
}

function fit() {
  const avail = Math.max(200, el.scroll.clientWidth - state.view.headW - 40);
  state.pxPerTick = avail / state.view.lengthTicks;
  rebuildView();
  el.scroll.scrollLeft = 0;
  el.zoomLabel.textContent = Math.round(state.pxPerTick / 0.04 * 100) + '%';
  saveViewPrefs();
  sendControl('fit', {});          // 中继过去的"适应窗口"由对方按自己的宽度算
  paint();
}

/* ------------------------------------------------------------------ 主题 */

let themeName = 'aqua';
let themeCustom = {};

function initTheme() {
  const saved = loadTheme();
  themeName = THEMES[saved.name] ? saved.name : 'aqua';
  themeCustom = saved.custom || {};
  applyTheme(themeName, themeCustom);
}

function setTheme(name) {
  themeName = THEMES[name] ? name : 'aqua';
  themeCustom = {};
  applyTheme(themeName, themeCustom);
  saveTheme({ name: themeName, custom: {} });
  syncSettingsUi();
  paint();
}

function setAccent(color) {
  themeCustom = { '--accent': color };
  applyTheme(themeName, themeCustom);
  saveTheme({ name: themeName, custom: themeCustom });
  paint();
}

/* ------------------------------------------------------------------ 启动 */

// 把一份设置（本地的 localStorage，或服务端/别的窗口给的）套到 state 上。
// 参数省略时读本窗口的 localStorage；中继过来的那份由 applyRemotePrefs 传进来。
function applyViewPrefs(p = loadViewPrefs()) {
  if (p.showClipNames === false) state.showClipNames = false;
  else if (p.showClipNames === true) state.showClipNames = true;
  if (p.followMode === 'center') state.followMode = 'center';
  else if (p.followMode === 'page') state.followMode = 'page';
  if (p.viewMode === 'midi') state.viewMode = 'midi';
  else if (p.viewMode === 'arrange') state.viewMode = 'arrange';
  if (typeof p.speed === 'number' && p.speed > 0) state.speed = p.speed;
  // 缩放也记住（上限跟 zoom()/zoomAt() 保持一致）
  if (typeof p.pxPerTick === 'number' && isFinite(p.pxPerTick)) {
    state.pxPerTick = Math.min(2.0, Math.max(0.002, p.pxPerTick));
  }
  // 导出模式 / 干净模式 / 轨道头：两个方向都要处理 —— 别的窗口可能是"关掉"，
  // 只处理 false 的话广播过来的"打开"就套不上。
  if (typeof p.exportMode === 'boolean') {
    state.exportMode = p.exportMode;
    document.body.classList.toggle('export', state.exportMode);
    setCanvasExportMode(state.exportMode);   // timeline.js 的全局函数（标尺 = 0、不画网格）
  }
  if (typeof p.rowH === 'number' && isFinite(p.rowH)) {
    state.rowH = Math.min(ROW_H_MAX, Math.max(ROW_H_MIN, p.rowH));
  }
  if (typeof p.semiH === 'number' && isFinite(p.semiH)) {
    state.semiH = Math.min(SEMI_H_MAX, Math.max(SEMI_H_MIN, p.semiH));
  }
  if (p.fx && typeof p.fx === 'object') Object.assign(state.fx, p.fx);
  if (Array.isArray(p.hiddenTracks)) {
    // 这时工程还没载入，先按原样收下，载入后再按轨道数剪一遍（见 boot）
    state.hiddenTracks = new Set(p.hiddenTracks.filter((i) => Number.isInteger(i) && i >= 0));
  }
  if (typeof p.kindFilter === 'string') state.kindFilter = p.kindFilter;
  if (Array.isArray(p.lanes)) {
    state.lanes = normalizeLanes(p.lanes);
    laneSeq = state.lanes.length;
  }
  if (typeof p.laneH === 'number' && isFinite(p.laneH)) {
    state.laneH = Math.min(LANE_H_MAX, Math.max(LANE_H_MIN, Math.round(p.laneH)));
  }
  // 音频区的显示偏好（数据本身走 /audiolanes，不在这儿）
  if (typeof p.audioSnap === 'boolean') state.audioSnap = p.audioSnap;
  if (typeof p.audioPlay === 'boolean') state.audioPlay = p.audioPlay;
  if (typeof p.audioShow === 'boolean') state.audioShow = p.audioShow;
  if (typeof p.showHeads === 'boolean') state.showHeads = p.showHeads;
  if (typeof p.showChrome === 'boolean') {
    state.showChrome = p.showChrome;
    if (!p.showChrome) state.showHeads = false;   // 干净模式连轨道头一起收
    document.body.classList.toggle('clean', !p.showChrome);
  }
}

// 控制器栏的规范化：只认已知类型、去掉重复的 CC、补上 id
function normalizeLanes(lanes) {
  return lanes
    .filter((l) => l && (l.kind === 'velocity' || l.kind === 'cc'))
    .map((l, i) => ({
      id: typeof l.id === 'string' ? l.id : `lane${i + 1}`,
      kind: l.kind,
      cc: Number.isInteger(l.cc) ? Math.min(127, Math.max(0, l.cc)) : 0,
    }))
    .filter((l, i, arr) => arr.findIndex(
      (o) => o.kind === l.kind && (l.kind !== 'cc' || o.cc === l.cc)) === i);
}

// 状态栏那行统计：随视图模式变（走带看轨道/片段，钢琴窗看音符/音域）
function updateStatusLine() {
  const v = state.view;
  const bar = Math.max(1, Math.round(v.lengthTicks / v.barTicks));
  const src = state.dataSource === 'server' ? '本地服务' : 'project.json';
  const tempo = state.tempo || { points: 1, totalSec: 0 };
  const dur = tempo.totalSec ? ` · 时长 ${mmss(tempo.totalSec)}` : '';
  const tempoText = tempo.points > 1 ? `速度轨 ${tempo.points} 点` : `${(state.project.meta.bpm || 0).toFixed(1)} BPM 定速`;
  if (v.mode === 'midi') {
    const notes = v.notes || [];
    const range = notes.length
      ? `${pitchName(Math.min(...notes.map((n) => n.pitch)))}–${pitchName(Math.max(...notes.map((n) => n.pitch)))}`
      : '—';
    const tracks = (v.noteTracks || []).length;
    const laneText = state.lanes.length
      ? ` · 控制器栏 ${state.lanes.length}（${state.lanes.map(laneTitle).join('、')}）` : '';
    el.status.textContent =
      `钢琴窗 · ${notes.length} 音符 · ${tracks} 条 MIDI 轨 · 音域 ${range} · `
      + `长度 ${bar} 小节${dur} · ${tempoText}${laneText} · 数据来源 ${src}`;
    return;
  }
  const nClips = state.project.tracks.reduce((a, t) => a + t.clips.length, 0);
  const nNotes = state.project.tracks.reduce(
    (a, t) => a + t.clips.reduce((b, c) => b + (c.notes ? c.notes.length : 0), 0), 0);
  const nTracks = state.project.tracks.length;
  const hid = state.hiddenTracks.size;
  const audio = state.audioLanes.length
    ? ` · 音频轨 ${state.audioLanes.length}（${state.audioLanes.reduce((a, l) => a + l.clips.length, 0)} 段）`
    : '';
  el.status.textContent =
    `${nTracks} 轨道${hid ? `（隐藏 ${hid}）` : ''} · ${nClips} 片段 · ${nNotes} 音符${audio} · `
    + `长度 ${bar} 小节${dur} · ${tempoText} · 数据来源 ${src}`;
}

function mmss(sec) {
  const s = Math.max(0, Math.round(sec));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}

function laneTitle(lane) {
  if (lane.kind === 'velocity') return '力度';
  const found = ccChoices().find((c) => c.cc === lane.cc);
  return `CC${lane.cc}${found ? ' ' + found.name : ''}`;
}

async function boot() {
  initTheme();
  bindUi();
  applyViewPrefs();
  renderMenu();          // 先把菜单 DOM 建好（隐藏着），元素随时可取
  try {
    state.project = await loadProject();
  } catch (err) {
    el.empty.hidden = false;
    // 自己开 index.html（没跑后端）时最容易撞上这个：给一句能照着做的提示
    el.emptyMsg.textContent = `${err.message || err} —— 请用 python -m dawview "你的工程.cpr|.flp|.rpp" 打开；`
      + '想先看示例：python -m dawview docs/demo-project.json';
    el.status.textContent = '载入失败';
    return;
  }
  const meta = state.project.meta || {};
  if (!state.project.tracks || !state.project.tracks.length) {
    el.empty.hidden = false;
    el.emptyMsg.textContent = '解析成功但未找到轨道。可能是暂不支持的工程版本。';
    return;
  }
  el.projInfo.textContent =
    `${meta.projectName || '未命名'} · ${meta.host || '?'} ${meta.hostVersion || ''} · `
    + `${meta.bpm} BPM · ${meta.timeSig[0]}/${meta.timeSig[1]} · ${meta.sampleRate} Hz`;
  el.zoomLabel.textContent = Math.round(state.pxPerTick / 0.04 * 100) + '%';

  // 上次记住的"隐藏轨道"按这次工程的轨道数剪一遍（换了工程，下标可能越界）
  const nTracks = state.project.tracks.length;
  state.hiddenTracks = new Set([...state.hiddenTracks].filter((i) => i < nTracks));
  // 服务端那份共享设置（OBS 浏览器源就是靠它自动长得跟 app 窗口一样）：
  // 要在 rebuildView 之前套用（视图模式 / 行高 / 干净模式都影响这一帧怎么画）。
  await pullPrefs();
  state.hiddenTracks = new Set([...state.hiddenTracks].filter((i) => i < nTracks));
  loadTrackColors();      // 这个工程上次调过的轨道颜色
  mergeRemoteColors();    // 服务端那份（有的话以它为准）
  state.tempo = buildTempo(state.project);   // 速度轨（变速播放用）
  await loadAudioLanes();    // 用户自己导入的音频轨（没连本地服务就是空的、只读不了）
  // 没有本地服务时音频轨用不了：按钮直接置灰，别让人白点
  if (el.btnAudio) el.btnAudio.disabled = !state.audioAvailable;
  if (el.btnAudio) el.btnAudio.title = state.audioAvailable
    ? '导入音频文件（快捷键 I）—— 也可以直接把文件拖进来'
    : '音频轨要连本地服务才有（用 run.bat / python -m dawview 打开）';

  rebuildView();
  state.playheadTick = 0;
  updatePosLabel();
  updateStatusLine();
  renderTrackMenu();
  paint();
  loadAudioPeaks();          // 波形解码是异步的，解好一份重画一次

  window.dawview = {   // 便于自动化验证
    state, paint, setPlaying, setClean, isClean, setClipNames, setFollowMode,
    zoomAt, zoomRows, followPlayhead, rebuildView, setViewMode, setHeads,
    setRowHeight, setSemiHeight, setSpeed, setFx, toggleMenu, renderMenu,
    collectHits, pruneHits, updateStatusLine,
    toggleTrackMenu, renderTrackMenu, setTrackVisible, toggleAllTracks, applyTrackFilter,
    filterByKind, renderTrackKindFilter, trackKindCounts, kindOf, KIND_ORDER,
    applyTrackGradient, clearVisibleTrackColors, gradientFromHue, gradientFromPalette,
    themeIsDark, hexToRgb, rgbToHsl, hslToHex,
    updatePosLabel,
    setTrackColor, trackColorHex, loadTrackColors, saveTrackColors, swatchTrackAt,
    openSwatchPop, closeSwatchPop, toggleSwatchPop, renderSwatchPop, SWATCH_PALETTE,
    buildTempo, rateAt, ticksPerSecond, mmss, frame,
    isClean, setClean, isExport, setExportMode, getRulerH, setCanvasExportMode,
    laneLayout, laneLabelText, LANE_HEAD_H, LANE_MIN_H,
    addLane, removeLane, setLaneCc, setVelocityLane, setLaneHeight, laneOf, laneTitle,
    ccChoices, LANE_H_MIN, LANE_H_MAX,
    // 多窗口联动（OBS）：验证脚本用这些，外面也能拿它们手动发消息
    setTheme, setAccent, applyViewPrefs, applyRemotePrefs, applyRemoteControl,
    CONTROL_ACTIONS, RELAY, sendControl, pushPrefs, pullPrefs, currentViewPrefs,
    mergeRemoteColors, applyZoomTo, setLanesFromRemote, setHiddenFromRemote,
    goHome, seekToTick, syncTick, maybeSyncTick, normalizeLanes,
    // 用户音频轨：验证脚本和手动调试都走这些
    importAudioFiles, uploadAudio, loadAudioLanes, pushAudioLanes, scheduleAudioSave,
    addAudioLaneAndShow, removeAudioLane, removeAudioClip, toggleAudioMute,
    setAudioSnap, setAudioPlay, setAudioShow, audioStart, audioStop, audioPlanNow,
    audioReadout, audioSrcDur, audioSnapToGrid, audioTickAt, audioGridTicks,
    audioBarClick, audioHeadClick, startAudioDrag, onAudioDragMove, onAudioDragEnd,
    applyRemoteAudioLanes, loadAudioPeaks, audioEngine, normAudioLanes,
    getClientId: () => serverClientId,
    isHost: () => IS_HOST,
    hasLocalPrefs,
  };

  // 连上本地服务（后端靠这条长连接判断"页面还开着"）
  connectToServer();
}

boot();
