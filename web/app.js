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
};

const VIEW_KEY = 'dawview.view';
const ROW_H_MIN = 22;
const ROW_H_MAX = 140;
const SEMI_H_MIN = 7;
const SEMI_H_MAX = 40;

function saveViewPrefs() {
  try {
    localStorage.setItem(VIEW_KEY, JSON.stringify({
      showChrome: state.showChrome, showHeads: state.showHeads,
      showClipNames: state.showClipNames, followMode: state.followMode,
      rowH: state.rowH, semiH: state.semiH, viewMode: state.viewMode,
      speed: state.speed, fx: state.fx,
      hiddenTracks: [...state.hiddenTracks],
      kindFilter: state.kindFilter,
    }));
  } catch (e) { /* 隐私模式忽略 */ }
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

// webui.js 在 DOMContentLoaded 才创建 globalThis.webui，而且 WebSocket 连上
// 之前调用后端函数是无效的 —— 必须等到"桥存在且已连接"再取数据，
// 否则会误判"没有桥"而退回 project.json。
async function waitForBridge(timeoutMs = 4000) {
  const t0 = Date.now();
  let sawBridge = false;
  while (Date.now() - t0 < timeoutMs) {
    const b = window.webui;
    if (b && typeof b.call === 'function') {
      sawBridge = true;
      let connected = true;
      try {
        if (typeof b.isConnected === 'function') connected = b.isConnected();
      } catch (e) {
        connected = false;
      }
      if (connected) return b;
    } else if (!sawBridge && Date.now() - t0 > 900) {
      // 页面里压根没有 webui.js（例如直接用浏览器打开）—— 别白等
      return null;
    }
    await new Promise((r) => setTimeout(r, 50));
  }
  return null;
}

async function loadProject() {
  const bridge = await waitForBridge();
  if (bridge) {
    try {
      const raw = typeof bridge.call === 'function'
        ? await bridge.call('loadProject')
        : await window.loadProject();
      if (raw) {
        state.dataSource = 'bridge';
        return JSON.parse(raw);
      }
    } catch (e) {
      console.warn('[dawview] webui 桥调用失败，回退 project.json：', e);
    }
  }
  const res = await fetch('project.json', { cache: 'no-store' });
  if (!res.ok) throw new Error(`project.json 读取失败（HTTP ${res.status}）`);
  state.dataSource = 'file';
  return res.json();
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
  };
  const project = { ...state.project, tracks };
  state.view = state.viewMode === 'midi'
    ? makeMidiView(project, { ...opts, semiH: state.semiH })
    : makeView(project, { ...opts, rowH: state.rowH });
  resizeSpacer();
}

function resizeSpacer() {
  const size = contentSize(state.view, el.scroll.clientWidth);
  el.spacer.style.width = size.width + 'px';
  el.spacer.style.height = size.height + 'px';
}

function paint() {
  if (!state.view) return;
  state.scrollX = el.scroll.scrollLeft;
  state.scrollY = el.scroll.scrollTop;
  el.canvas.style.transform = `translate(${state.scrollX}px, ${state.scrollY}px)`;
  draw(el.canvas, state.view, state);
}

/* -------------------------------------------------------------- 走带播放 */

function ticksPerSecond() {
  const meta = state.project.meta || {};
  return ((meta.bpm || 120) / 60) * (meta.ppq || 480);
}

function frame(ts) {
  if (!state.playing) return;
  if (!state.lastTs) state.lastTs = ts;
  const dt = Math.min(0.25, (ts - state.lastTs) / 1000);
  state.lastTs = ts;
  const prev = state.playheadTick;
  state.playheadTick += dt * ticksPerSecond() * state.speed;

  const end = state.view.lengthTicks;
  if (state.playheadTick >= end) {
    state.playheadTick = end;
    setPlaying(false);
  }
  collectHits(prev, state.playheadTick);
  pruneHits();
  followPlayhead();
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
  state.playing = on;
  state.lastTs = 0;
  if (!on) state.hits = [];          // 停下就不留动效残影
  el.btnPlay.textContent = on ? '❚❚' : '▶';
  if (on) requestAnimationFrame(frame);
}

function updatePosLabel() {
  el.posLabel.textContent = barLabel(state.view, state.playheadTick);
}

/* ------------------------------------------------------------------ 交互 */

function bindUi() {
  el.scroll.addEventListener('scroll', paint, { passive: true });
  window.addEventListener('resize', () => { resizeSpacer(); paint(); });

  el.btnPlay.addEventListener('click', () => setPlaying(!state.playing));
  el.btnHome.addEventListener('click', () => {
    state.playheadTick = 0;
    state.hits = [];
    el.scroll.scrollLeft = 0;
    updatePosLabel();
    paint();
  });

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
    if (e.code === 'KeyM') { setViewMode(state.viewMode === 'midi' ? 'arrange' : 'midi'); }
  });

  el.canvas.addEventListener('mousedown', (e) => {
    if (e.button !== 0) return;      // 右键留给下面的 contextmenu（恢复默认色）
    const rect = el.canvas.getBoundingClientRect();
    const x = e.clientX - rect.left;
    const y = e.clientY - rect.top;
    // 轨道头上的色卡：点它开颜色选择器，别去动播放头
    const sw = swatchTrackAt(x, y);
    if (sw >= 0) { e.preventDefault(); toggleSwatchPop(sw, e.clientX, e.clientY); return; }
    if (x < state.view.headW) return;
    closeSwatchPop();
    state.playheadTick = xToTick(state.view, x);
    state.hits = [];
    updatePosLabel();
    paint();
  });

  // 右键点色卡 = 恢复默认色
  el.canvas.addEventListener('contextmenu', (e) => {
    const rect = el.canvas.getBoundingClientRect();
    const vi = swatchTrackAt(e.clientX - rect.left, e.clientY - rect.top);
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
  if (on) toast('干净模式：按 H 或 Esc 退出');
  paint();
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
  syncSettingsUi();
  paint();
}

function setFollowMode(mode) {
  state.followMode = mode === 'center' ? 'center' : 'page';
  saveViewPrefs();
  syncSettingsUi();
}

function setHeads(show) {
  state.showHeads = !!show;
  applyHeads();
  saveViewPrefs();
  syncSettingsUi();
  paint();
}

function setRowHeight(v) {
  state.rowH = Math.min(ROW_H_MAX, Math.max(ROW_H_MIN, v));
  rebuildView();
  saveViewPrefs();
  syncSettingsUi();
  paint();
}

function setSemiHeight(v) {
  state.semiH = Math.min(SEMI_H_MAX, Math.max(SEMI_H_MIN, v));
  if (state.view.mode === 'midi') rebuildView();
  saveViewPrefs();
  syncSettingsUi();
  paint();
}

function setSpeed(v) {
  state.speed = v;
  saveViewPrefs();
  syncSettingsUi();
}

function setFx(patch) {
  Object.assign(state.fx, patch);
  saveViewPrefs();
  syncSettingsUi();
  paint();
}

/* ------------------------------------------------------ 设置菜单（二级） */

// 一级 = 分组，二级 = 组内选项。所有选项在这里声明，UI 自动生成。
const SETTINGS_SPEC = [
  { key: 'display', label: '显示', items: [
    { id: 'opt-clean', type: 'check', label: '干净模式', hint: '隐藏顶栏 / 轨道头 / 状态栏（快捷键 H）',
      get: () => isClean(), set: (v) => setClean(v) },
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
  paint();
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
  paint();
}

// Alt+滚轮：改行高（钢琴窗改半音行高），鼠标下的那一行保持不动
function zoomRows(factor, clientY) {
  const midi = state.view.mode === 'midi';
  const rect = el.scroll.getBoundingClientRect();
  const viewY = clientY === undefined ? el.scroll.clientHeight / 2 : clientY - rect.top;
  const cur = midi ? state.semiH : state.rowH;
  const rowIdx = (viewY + state.scrollY - RULER_H) / cur;
  const next = midi
    ? Math.min(SEMI_H_MAX, Math.max(SEMI_H_MIN, cur * factor))
    : Math.min(ROW_H_MAX, Math.max(ROW_H_MIN, cur * factor));
  if (Math.abs(next - cur) < 0.01) return;
  if (midi) state.semiH = next; else state.rowH = next;
  rebuildView();
  el.scroll.scrollTop = Math.max(0, RULER_H + rowIdx * next - viewY);
  saveViewPrefs();
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
  paint();
}

// 钢琴窗是全部 128 个琴键，一屏看不完 —— 进去时先把视野滚到音符所在的音区
function centerOnNoteRange() {
  const v = state.view;
  if (v.mode !== 'midi') return;
  const mid = ((v.noteLo === undefined ? 60 : v.noteLo) + (v.noteHi === undefined ? 60 : v.noteHi)) / 2;
  const y = RULER_H + (v.pitchHi - mid) * v.semiH - el.scroll.clientHeight / 2;
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
  paint();
}

function fit() {
  const avail = Math.max(200, el.scroll.clientWidth - state.view.headW - 40);
  state.pxPerTick = avail / state.view.lengthTicks;
  rebuildView();
  el.scroll.scrollLeft = 0;
  el.zoomLabel.textContent = Math.round(state.pxPerTick / 0.04 * 100) + '%';
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

// 上次的显示选项（干净模式 / 片段名 / 跟随 / 行高 / 视图模式 / 动效）
function applyViewPrefs() {
  const p = loadViewPrefs();
  if (p.showClipNames === false) state.showClipNames = false;
  if (p.followMode === 'center') state.followMode = 'center';
  if (p.viewMode === 'midi') state.viewMode = 'midi';
  if (typeof p.speed === 'number' && p.speed > 0) state.speed = p.speed;
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
  if (p.showHeads === false) state.showHeads = false;
  if (p.showChrome === false) {
    state.showChrome = false;
    state.showHeads = false;
    document.body.classList.add('clean');
  }
}

// 状态栏那行统计：随视图模式变（走带看轨道/片段，钢琴窗看音符/音域）
function updateStatusLine() {
  const v = state.view;
  const bar = Math.max(1, Math.round(v.lengthTicks / v.barTicks));
  const src = state.dataSource === 'bridge' ? 'webui 桥' : 'project.json';
  if (v.mode === 'midi') {
    const notes = v.notes || [];
    const range = notes.length
      ? `${pitchName(Math.min(...notes.map((n) => n.pitch)))}–${pitchName(Math.max(...notes.map((n) => n.pitch)))}`
      : '—';
    const tracks = (v.noteTracks || []).length;
    el.status.textContent =
      `钢琴窗 · ${notes.length} 音符 · ${tracks} 条 MIDI 轨 · 音域 ${range} · `
      + `长度 ${bar} 小节 · 数据来源 ${src}`;
    return;
  }
  const nClips = state.project.tracks.reduce((a, t) => a + t.clips.length, 0);
  const nNotes = state.project.tracks.reduce(
    (a, t) => a + t.clips.reduce((b, c) => b + (c.notes ? c.notes.length : 0), 0), 0);
  const nTracks = state.project.tracks.length;
  const hid = state.hiddenTracks.size;
  el.status.textContent =
    `${nTracks} 轨道${hid ? `（隐藏 ${hid}）` : ''} · ${nClips} 片段 · ${nNotes} 音符 · `
    + `长度 ${bar} 小节 · 数据来源 ${src}`;
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
    el.emptyMsg.textContent = `${err.message || err} —— 请用 python -m dawview "你的工程.cpr|.flp" 打开；`
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
  loadTrackColors();      // 这个工程上次调过的轨道颜色

  rebuildView();
  state.playheadTick = 0;
  updatePosLabel();
  updateStatusLine();
  renderTrackMenu();
  paint();

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
  };

  // 握手：告诉后端窗口已连上（后端用它判断窗口是否真的连上了）
  try {
    const b = window.webui;
    if (b && typeof b.call === 'function' && (!b.isConnected || b.isConnected())) {
      b.call('clientReady');
    }
  } catch (e) { /* 无桥时忽略 */ }
}

boot();
