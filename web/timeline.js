/* 时间线绘制：视口渲染（只画可见区域），滚动/缩放/播放都只是改状态后重画。
   坐标约定：所有 tick -> 像素换算都经 tickToX / xToTick，方便单独测试与替换。 */

const ROW_H = 44;         // 默认行高（Alt+滚轮可调）
const HEAD_W = 200;       // 默认轨道名栏宽（干净模式下为 0）
const RULER_H = 30;       // 默认标尺（上方时间轴）高度

// 标尺高度是可变的：导出模式下不画标尺（= 0）。所有几何都读 rulerH，
// 不读常量 —— 否则隐藏标尺后内容会整体上移 30px 对不齐。
let rulerH = RULER_H;
let exportMode = false;   // 导出模式：不画网格线（标尺 = 0；滚动条在 CSS 侧 body.export）

function setCanvasExportMode(on) {
  exportMode = !!on;
  rulerH = exportMode ? 0 : RULER_H;
}

function getRulerH() {
  return rulerH;
}

const CLIP_PAD = 4;
const KEYS_W = 64;        // 钢琴窗左侧键栏宽
const SEMI_H = 14;        // 钢琴窗每个半音的行高（Alt+滚轮可调）
const SWATCH_W = 26;      // 轨道头右侧色卡按钮宽
const SWATCH_H = 16;
const SWATCH_MIN_HEAD = 96;   // 轨道栏窄于此就不画色卡（放不下）
const LANE_HEAD_H = 18;       // 钢琴窗下部每栏的标题条高度
const LANE_MIN_H = 24;        // 单栏绘制区最小高度（再小就只剩一条线了）

// 用户音频区（自己导入的音频，见 web/audio.js）：标题条 + 每轨一行。
// 没有音频轨时标题条高度 = 0 —— 不显示音频区的工程，几何和以前一模一样。
const AUDIO_HEAD_H = 24;
const AUDIO_EDGE_W = 7;       // 片段左右缘的裁剪热区宽度
const AUDIO_MIN_CLIP_W = 24;  // 窄于这个宽度就不分左右缘了（左右三分）
const AUDIO_BTN_H = 18;
const AUDIO_BTN_Y = 3;        // 标题条里按钮的纵向偏移
// 标题条上的按钮：固定几何 —— 绘制和点击命中读同一份（文字宽度不参与定位，
// 否则命中区和画出来的框会差几个像素）
const AUDIO_BTN_IMPORT = { x: 84, w: 76 };
const AUDIO_BTN_NEW = { x: 166, w: 76 };
const AUDIO_BTN_SNAP = { x: 248, w: 82 };
// 轨道头右侧的两个按钮（静音 / 删除）
const AUDIO_MUTE_W = 22;
const AUDIO_DEL_W = 20;
const AUDIO_HEAD_BTN_GAP = 6;

const PITCH_NAMES = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];
const BLACK_KEYS = new Set([1, 3, 6, 8, 10]);

function pitchName(p) {
  return PITCH_NAMES[p % 12] + (Math.floor(p / 12) - 1);   // 60 -> C4
}

// '#rrggbb' 之间线性插值，用于按轨道给音符上色、动效叠色
function mixHex(a, b, t) {
  const pa = parseInt(a.slice(1), 16);
  const pb = parseInt(b.slice(1), 16);
  const ch = (v, s) => Math.round(((pa >> s & 255) * (1 - t)) + ((pb >> s & 255) * t));
  return '#' + [16, 8, 0].map((s) => ch(0, s).toString(16).padStart(2, '0')).join('');
}

// '#rrggbb' + alpha -> 'rgba(...)'，画光效渐变用
function hexA(hex, alpha) {
  const n = parseInt(hex.slice(1), 16);
  return `rgba(${n >> 16 & 255}, ${n >> 8 & 255}, ${n & 255}, ${alpha})`;
}

/* ------------------------------------------------------------ 播放动效 */

// 命中记录：{key, t}，t 是 performance.now()；这里算成 key -> 剩余强度(0..1)
function activeHits(state) {
  const map = new Map();
  const decay = (state.fx && state.fx.decay) || 400;
  const now = performance.now();
  for (const h of state.hits || []) {
    const age = now - h.t;
    if (age >= 0 && age < decay) {
      const v = 1 - age / decay;
      map.set(h.key, Math.max(map.get(h.key) || 0, v));
    }
  }
  return map;
}

function noteHitKey(pitch, tick) { return `n:${pitch}:${tick}`; }
function clipHitKey(trackIdx, tick) { return `c:${trackIdx}:${tick}`; }

function makeView(project, opts) {
  const meta = project.meta || {};
  const ppq = meta.ppq || 480;
  const sig = meta.timeSig || [4, 4];
  // 用户音频区：有音频轨才占标题条那 24px（导出的截图里不画标题条）
  const audioLanes = (opts.audioLanes || []).slice();
  // 音频片段可能被用户拖到工程结束之后：时间轴（画布宽度 / 标尺范围）得跟着长，
  // 不然拖出去的那截就画在可视区之外了。
  const audioTicksMax = audioLanes.reduce((a, lane) => Math.max(a,
    ...(lane.clips || []).map((c) => audioEndTick(opts.tempo || null, c)), 0), 0);
  return {
    mode: 'arrange',
    ppq,
    barTicks: ppq * (sig[0] || 4),
    beatTicks: ppq,
    tracks: project.tracks || [],
    audioLanes,
    audioBarH: (audioLanes.length && !exportMode) ? AUDIO_HEAD_H : 0,
    lengthTicks: Math.max(project.lengthTicks || 0, audioTicksMax, 1),
    pxPerTick: opts.pxPerTick,
    pitchLo: opts.pitchLo,
    pitchHi: opts.pitchHi,
    // 几何随视图走，便于干净模式隐藏名栏、Alt+滚轮改行高
    headW: opts.headW === undefined ? HEAD_W : opts.headW,
    rowH: opts.rowH || ROW_H,
  };
}

// 钢琴窗视图：只取工程里 MIDI 片段的音符，纵向按半音排
function makeMidiView(project, opts) {
  const meta = project.meta || {};
  const ppq = meta.ppq || 480;
  const sig = meta.timeSig || [4, 4];
  const tracks = project.tracks || [];
  const notes = [];
  const ccMap = new Map();       // CC 号 -> [[绝对 tick, 值 0..127], ...]
  const ccNames = {};
  for (let ti = 0; ti < tracks.length; ti++) {
    for (const clip of tracks[ti].clips || []) {
      if (clip.kind !== 'midi') continue;
      for (const n of clip.notes || []) {
        notes.push({
          tick: clip.startTick + n.startTick,
          lengthTick: n.lengthTick,
          pitch: n.pitch,
          velocity: n.velocity,
          track: ti,
        });
      }
      // 契约 v0.3：controllers[].points 的 tick 相对片段起点（同 Note.startTick）
      for (const cc of clip.controllers || []) {
        const arr = ccMap.get(cc.cc) || [];
        for (const pt of cc.points || []) {
          if (!Array.isArray(pt) || pt.length < 2) continue;
          arr.push([clip.startTick + Number(pt[0]), Number(pt[1])]);
        }
        ccMap.set(cc.cc, arr);
        if (!ccNames[cc.cc]) ccNames[cc.cc] = cc.name || `CC${cc.cc}`;
      }
    }
  }
  const ccs = [...ccMap.entries()].map(([cc, pts]) => {
    pts.sort((a, b) => a[0] - b[0]);
    return { cc, points: pts };
  }).sort((a, b) => a.cc - b.cc);
  notes.sort((a, b) => a.tick - b.tick);
  const pitches = notes.map((n) => n.pitch);
  const noteLo = pitches.length ? Math.min(...pitches) : 48;
  const noteHi = pitches.length ? Math.max(...pitches) : 72;
  return {
    mode: 'midi',
    ppq,
    barTicks: ppq * (sig[0] || 4),
    beatTicks: ppq,
    tracks,
    notes,
    ccs,
    ccNames,
    // 下部的力度 / CC 栏（显示偏好，来自 localStorage，不属于契约）
    lanes: (opts.lanes || []).map((l) => ({
      id: l.id,
      kind: l.kind === 'cc' ? 'cc' : 'velocity',
      cc: Number(l.cc) | 0,
      h: Math.max(LANE_MIN_H, Number(opts.laneH) || 84),
    })),
    noteTracks: [...new Set(notes.map((n) => n.track))],
    // 全 128 个琴键都画（含工程 MIDI 范围之外的），纵向靠滚动看
    pitchLo: 0,
    pitchHi: 127,
    noteLo,          // 音符实际音域：进钢琴窗时用它把视野滚到有内容的地方
    noteHi,
    lengthTicks: Math.max(project.lengthTicks || 0, 1),
    pxPerTick: opts.pxPerTick,
    semiH: opts.semiH || SEMI_H,
    headW: opts.headW === undefined ? KEYS_W : opts.headW,
  };
}

function contentSize(view, widthPx) {
  const height = view.mode === 'midi'
    ? rulerH + (view.pitchHi - view.pitchLo + 1) * view.semiH + 8
    : audioRowsBottom(view) + view.tracks.length * view.rowH + 8;
  return {
    width: Math.max(widthPx, view.headW + view.lengthTicks * view.pxPerTick + 40),
    height,
  };
}

function tickToX(view, tick) { return view.headW + tick * view.pxPerTick; }
function xToTick(view, x) { return Math.max(0, (x - view.headW) / view.pxPerTick); }

/* -------------------------------------------- 用户音频区的几何（走带视图） */

// 音频区标题条高度：没有音频轨时是 0（工程轨道的位置和以前一模一样）
function audioBarH(view) {
  return (view && view.mode === 'arrange') ? (view.audioBarH || 0) : 0;
}

// 一条音频轨的行顶（内容坐标，未减滚动量）
function audioLaneTop(view, i) {
  return rulerH + audioBarH(view) + i * view.rowH;
}

// 音频区底部 = 工程第一行的行顶
function audioRowsBottom(view) {
  return rulerH + audioBarH(view) + (view.audioLanes || []).length * view.rowH;
}

function rowTop(view, index) {
  return audioRowsBottom(view) + index * view.rowH;
}

// 画布坐标 -> 命中哪条音频轨（整行都算，拖放定位也用这个）
function audioLaneAt(view, x, y, scrollY = 0) {
  if (!view || view.mode !== 'arrange') return -1;
  const lanes = view.audioLanes || [];
  const cy = y + (scrollY || 0);
  for (let i = 0; i < lanes.length; i++) {
    const top = audioLaneTop(view, i);
    if (cy >= top && cy < top + view.rowH) return i;
  }
  return -1;
}

// 标题条上的三个按钮（画布坐标，已减纵向滚动量）；标题条藏起来时是 null
function audioBarRects(view, scrollY = 0) {
  if (!audioBarH(view)) return null;
  const y = rulerH - (scrollY || 0) + AUDIO_BTN_Y;
  const mk = (b) => ({ x: b.x, y, w: b.w, h: AUDIO_BTN_H });
  return { import: mk(AUDIO_BTN_IMPORT), add: mk(AUDIO_BTN_NEW), snap: mk(AUDIO_BTN_SNAP) };
}

// 画布坐标 -> 标题条上按的是哪个按钮：'import' | 'add' | 'snap' | ''（没按到）
function audioBarHit(view, x, y, scrollY = 0) {
  const r = audioBarRects(view, scrollY);
  if (!r) return '';
  const cy = y + (scrollY || 0);
  if (cy < rulerH || cy > rulerH + AUDIO_HEAD_H) return '';
  for (const [key, box] of Object.entries(r)) {
    if (x >= box.x && x <= box.x + box.w && y >= box.y && y <= box.y + box.h) return key;
  }
  return '';
}

// 音频轨头右侧的 静音 / 删除 按钮（画布坐标，已减纵向滚动量）
function audioHeadRects(view, i, scrollY = 0) {
  if (!view || view.mode !== 'arrange' || view.headW < SWATCH_MIN_HEAD) return null;
  const cy = audioLaneTop(view, i) - (scrollY || 0);
  const h = Math.min(AUDIO_BTN_H, Math.max(10, view.rowH - 14));
  const y = cy + (view.rowH - h) / 2;
  const delX = view.headW - 10 - AUDIO_DEL_W;
  return {
    mute: { x: delX - AUDIO_HEAD_BTN_GAP - AUDIO_MUTE_W, y, w: AUDIO_MUTE_W, h },
    del: { x: delX, y, w: AUDIO_DEL_W, h },
  };
}

// 画布坐标 -> 音频轨头上的按钮：{lane, kind:'mute'|'del'} 或 null
function audioHeadHit(view, x, y, scrollY = 0) {
  const i = audioLaneAt(view, x, y, scrollY);
  if (i < 0) return null;
  const r = audioHeadRects(view, i, scrollY);
  if (!r) return null;
  for (const kind of ['mute', 'del']) {
    const box = r[kind];
    if (x >= box.x - 3 && x <= box.x + box.w + 3 && y >= box.y && y <= box.y + box.h) {
      return { lane: i, kind };
    }
  }
  return null;
}

// 一个音频片段的矩形（画布坐标：x 已减横向滚动量、y 已减纵向滚动量）。
// 右缘由"开始秒 + 取多长"反算回 tick —— 播放和画法共用 web/audio.js 的那套秒数数学。
// 注意 scrollX/scrollY 要传"画布视角已经减掉的滚动量"，和绘制那边同一个坐标系；
// 漏传 scrollX 就会在横向滚动后抓不到片段（画在左边、判定留在原地）。
function audioClipRect(view, lane, clip, scrollY = 0, state = null, scrollX = 0) {
  const i = (view.audioLanes || []).indexOf(lane);
  const rowY = audioLaneTop(view, i < 0 ? 0 : i) - (scrollY || 0);
  const x0 = tickToX(view, clip.startTick) - (scrollX || 0);
  const x1 = tickToX(view, audioEndTick((state && state.tempo) || null, clip)) - (scrollX || 0);
  return {
    x0,
    x1,
    y: rowY + CLIP_PAD,
    h: Math.max(6, view.rowH - CLIP_PAD * 2 - 1),
  };
}

// 画布坐标 -> 命中的音频片段：{lane, clip, edge:'left'|'right'|'body'} 或 null。
// x/y 是**画布坐标**（还没加滚动量），scrollX/scrollY 是已经减掉的滚动量 —— 函数自己加回来。
function audioClipAt(view, x, y, scrollY = 0, scrollX = 0, state = null) {
  const li = audioLaneAt(view, x, y, scrollY);
  if (li < 0) return null;
  const lane = view.audioLanes[li];
  const cy = y + (scrollY || 0);
  const rowTopY = audioLaneTop(view, li);
  if (cy < rowTopY + CLIP_PAD - 2 || cy > rowTopY + view.rowH - CLIP_PAD + 2) return null;
  const cx = x;
  for (let ci = (lane.clips || []).length - 1; ci >= 0; ci--) {
    const clip = lane.clips[ci];
    const r = audioClipRect(view, lane, clip, scrollY, state, scrollX);
    if (cx < r.x0 - 1 || cx > r.x1 + 1) continue;
    const w = Math.max(1, r.x1 - r.x0);
    const edge = Math.min(AUDIO_EDGE_W, Math.max(4, w / 3));
    if (cx - r.x0 <= edge) return { lane: li, clip: ci, edge: 'left' };
    if (r.x1 - cx <= edge) return { lane: li, clip: ci, edge: 'right' };
    return { lane: li, clip: ci, edge: 'body' };
  }
  return null;
}


/* ---------------------------------------------------------- 轨道颜色 */

// 轨道自定义色（纯前端偏好，存 state.trackColors，见 app.js）。
// 键是**工程里的轨道下标**（view.tracks 是过滤后的子集，可能不是同一套下标），
// 所以 rebuildView 会给每条可见轨道挂一个 projectIndex。
function trackHex(state, view, viewIndex) {
  const t = (view.tracks || [])[viewIndex];
  const pi = (t && typeof t.projectIndex === 'number') ? t.projectIndex : viewIndex;
  const map = (state && state.trackColors) || {};
  return map[pi] || '';
}

// 片段底色（没自定轨色时）：音频 = 音频色，自动化 = 自动化色，其他 = 次要色，MIDI = MIDI 色。
// 自动化片段是 FL 工程里的大头（万古城：3274 条里 1418 条），单给一个颜色才看得清结构。
function clipKindHex(c, clip) {
  const kind = (clip && clip.kind) || 'midi';
  if (kind === 'audio') return c.audio;
  if (kind === 'automation') return c.auto;
  if (kind === 'other') return c.muted;
  return c.midi;
}

// 轨道头右侧的色卡按钮（画布坐标，已减纵向滚动量 —— 和绘制共用同一套坐标）；
// 轨道栏太窄时不画。
// 注意：必须传 scrollY。旧写法用未减滚动量的 y，滚动后按钮画在原处不动，
// 看起来就是"往下滚，按钮一个个从上面消失"（其实是被钉在了视口里）。
function trackSwatchRect(view, i, scrollY = 0) {
  if (!view || view.mode !== 'arrange' || view.headW < SWATCH_MIN_HEAD) return null;
  const h = Math.min(SWATCH_H, Math.max(10, view.rowH - 14));
  return {
    x: view.headW - SWATCH_W - 10,
    y: rowTop(view, i) - (scrollY || 0) + (view.rowH - h) / 2,
    w: SWATCH_W,
    h,
  };
}

// 画布坐标 -> 命中哪条轨道的色卡（热区比图形略宽，好点），没命中返回 -1
function hitTrackSwatch(view, x, y, scrollY = 0) {
  if (!view || view.mode !== 'arrange') return -1;
  const sy = scrollY || 0;
  for (let i = 0; i < (view.tracks || []).length; i++) {
    const r = trackSwatchRect(view, i, sy);
    if (!r) continue;
    const top = rowTop(view, i) - sy;
    if (y < top || y > top + view.rowH) continue;
    if (x >= r.x - 5 && x <= r.x + r.w + 5) return i;
  }
  return -1;
}

function roundRectPath(ctx, x, y, w, h, r) {
  if (typeof ctx.roundRect === 'function') { ctx.beginPath(); ctx.roundRect(x, y, w, h, r); return; }
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}

function barLabel(view, tick) {
  const bar = Math.floor(tick / view.barTicks) + 1;
  const beat = Math.floor((tick % view.barTicks) / view.beatTicks) + 1;
  const pct = Math.floor(((tick % view.beatTicks) / view.beatTicks) * 960);
  return `${bar}.${beat}.${pct}`;
}

/* ------------------------------------------------------------------ 绘制 */

function draw(canvas, view, state) {
  const ctx = canvas.getContext('2d');
  const dpr = window.devicePixelRatio || 1;
  const w = canvas.clientWidth;
  const h = canvas.clientHeight;

  if (canvas.width !== Math.round(w * dpr) || canvas.height !== Math.round(h * dpr)) {
    canvas.width = Math.round(w * dpr);
    canvas.height = Math.round(h * dpr);
  }
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, w, h);

  const c = {
    bg: readVar('--bg'), panel: readVar('--panel'), border: readVar('--border'),
    grid: readVar('--grid'), gridBeat: readVar('--grid-beat'),
    text: readVar('--text'), muted: readVar('--muted'), accent: readVar('--accent'),
    midi: readVar('--clip-midi'), audio: readVar('--clip-audio'), note: readVar('--note'),
    auto: readVar('--clip-auto'),
  };

  const sx = state.scrollX;
  const sy = state.scrollY;
  const hits = activeHits(state);
  const fx = state.fx || {};

  // 钢琴窗模式走另一套绘制
  if (view.mode === 'midi') {
    drawMidiRoll(ctx, view, state, c, w, h, hits, fx);
    return;
  }

  const headW = view.headW;
  const rowH = view.rowH;
  const audioLanes = view.audioLanes || [];

  // 轨道行底色（含行分隔）
  for (let i = 0; i < view.tracks.length; i++) {
    const y = rowTop(view, i) - sy;
    if (y > h || y + rowH < rulerH) continue;
    ctx.fillStyle = i % 2 ? c.panel : c.bg;
    ctx.fillRect(0, y, w, rowH);
    if (!exportMode) {               // 行分隔线也算"背景格线"
      ctx.fillStyle = c.border;
      ctx.fillRect(0, y + rowH - 1, w, 1);
    }
  }

  // 用户音频区（自己导入的音频）：标题条 + 每轨一行。没有音频轨就整块不存在 ——
  // 也就不会把工程轨道整体往下挤。
  if (audioLanes.length && audioBarH(view)) {
    const by = rulerH - sy;
    if (by + AUDIO_HEAD_H > rulerH && by < h) {
      ctx.fillStyle = c.panel;
      ctx.fillRect(0, by, w, AUDIO_HEAD_H);
      ctx.fillStyle = c.border;
      ctx.fillRect(0, by + AUDIO_HEAD_H - 1, w, 1);
    }
  }
  for (let i = 0; i < audioLanes.length; i++) {
    const y = audioLaneTop(view, i) - sy;
    if (y > h || y + rowH < rulerH) continue;
    ctx.fillStyle = i % 2 ? c.panel : c.bg;
    ctx.fillRect(0, y, w, rowH);
    if (!exportMode) {
      ctx.fillStyle = c.border;
      ctx.fillRect(0, y + rowH - 1, w, 1);
    }
  }

  // 网格 + 标尺（两种视图共用）
  drawGridAndRuler(ctx, view, sx, w, h, c, headW);

  // 片段 + 轨道头一律裁到标尺以下：纵向滚动时压线那一行会有一半在标尺区域，
  // 旧写法只在"整行滚出"时 continue，压线的行会直接画进标尺里（穿透标尺）。
  ctx.save();
  ctx.beginPath();
  ctx.rect(0, rulerH, w, h - rulerH);
  ctx.clip();

  // 片段
  for (let i = 0; i < view.tracks.length; i++) {
    const y = rowTop(view, i) - sy;
    if (y > h || y + rowH < rulerH) continue;
    for (const clip of view.tracks[i].clips || []) {
      drawClip(ctx, view, clip, y, sx, w, c, state, i, hits, fx);
    }
  }

  // 用户音频片段
  for (let i = 0; i < audioLanes.length; i++) {
    const y = audioLaneTop(view, i) - sy;
    if (y > h || y + rowH < rulerH) continue;
    for (const clip of audioLanes[i].clips || []) {
      drawAudioClip(ctx, view, audioLanes[i], clip, y, sx, w, c, state);
    }
  }

  // 轨道名栏（钉在左侧，覆盖片段与网格）；干净模式下 headW=0 即整块不画
  if (headW > 0) {
    ctx.fillStyle = c.panel;
    ctx.fillRect(0, rulerH, headW, h - rulerH);
    ctx.fillStyle = c.border;
    ctx.fillRect(headW - 1, rulerH, 1, h - rulerH);
    for (let i = 0; i < view.tracks.length; i++) {
      const y = rowTop(view, i) - sy;
      if (y > h || y + rowH < rulerH) continue;
      drawTrackHead(ctx, view.tracks[i], y, c, headW, rowH,
                    trackHex(state, view, i), trackSwatchRect(view, i, sy));
    }
    for (let i = 0; i < audioLanes.length; i++) {
      const y = audioLaneTop(view, i) - sy;
      if (y > h || y + rowH < rulerH) continue;
      drawAudioHead(ctx, audioLanes[i], y, c, headW, rowH,
                    audioHeadRects(view, i, sy), audioLanes[i].muted);
    }
  } else {
    // 干净模式没有轨道头，静音状态就靠行左缘那根色条表示
    ctx.fillStyle = c.audio;
    for (let i = 0; i < audioLanes.length; i++) {
      if (audioLanes[i].muted) continue;
      const y = audioLaneTop(view, i) - sy;
      if (y > h || y + rowH < rulerH) continue;
      ctx.fillRect(0, y, 3, rowH - 1);
    }
  }

  // 音频区标题条上的文字与按钮（压在轨道头之上，跟着内容滚）
  if (audioLanes.length && audioBarH(view)) {
    drawAudioBar(ctx, view, state, c, w, sy, headW);
  }
  drawAudioDropMark(ctx, view, state, c, h);
  ctx.restore();

  // 标尺左上角那格（它本来就在标尺里，画在裁剪之外）
  if (headW > 0) {
    ctx.fillStyle = c.panel;
    ctx.fillRect(0, 0, headW, rulerH);
    ctx.fillStyle = c.border;
    ctx.fillRect(headW - 1, 0, 1, rulerH);
    ctx.fillStyle = c.muted;
    ctx.fillText('轨道', 12, rulerH / 2 - 1);
  }

  // 播放头（只画在内容区：不开干净模式时拖尾不能盖到轨道头上）
  const px = Math.round(tickToX(view, state.playheadTick) - sx) + 0.5;
  if (px >= headW && px <= w) drawPlayhead(ctx, c, px, h, state, fx, headW, w);
}

// 播放头：走带时后面拖一段矩形拖尾（动效可关）
// clipLeft/w：内容区左边界。拖尾向左延伸时会伸进轨道头/钢琴键栏，
// 这里把整块播放头绘制裁到内容区，轨道头永远在最上层。
function drawPlayhead(ctx, c, x, h, state, fx, clipLeft, w) {
  const clipped = clipLeft > 0 && w > clipLeft;
  if (clipped) {
    ctx.save();
    ctx.beginPath();
    ctx.rect(clipLeft, 0, w - clipLeft, h);
    ctx.clip();
  }

  const on = fx.on !== false && fx.head !== false && state.playing;
  if (on) {
    const k = fx.strength || 1;
    const trail = 130 * k;
    const g = ctx.createLinearGradient(x - trail, 0, x, 0);
    g.addColorStop(0, hexA(c.accent, 0));
    g.addColorStop(1, hexA(c.accent, 0.42 * k));
    ctx.fillStyle = g;
    ctx.fillRect(x - trail, 0, trail, h);
  }

  ctx.strokeStyle = c.accent;
  ctx.lineWidth = 1.5;
  ctx.beginPath();
  ctx.moveTo(x, 0);
  ctx.lineTo(x, h);
  ctx.stroke();
  ctx.lineWidth = 1;
  ctx.fillStyle = c.accent;
  ctx.beginPath();
  ctx.moveTo(x - 5, 0);
  ctx.lineTo(x + 5, 0);
  ctx.lineTo(x, 9);
  ctx.closePath();
  ctx.fill();

  if (clipped) ctx.restore();
}

// 轨道头：左侧色条 + 名字 + 类型 + 右侧色卡按钮（color 为自定色，空 = 跟主题）
function drawTrackHead(ctx, track, y, c, headW, rowH, color, swatch) {
  const kindText = { instrument: '乐器', midi: 'MIDI', audio: '音频', folder: '文件夹',
                     marker: '标记', tempo: '速度', chord: '和弦',
                     automation: '自动化', other: '其他' };
  ctx.font = '12px "Segoe UI", "Microsoft YaHei", system-ui, sans-serif';
  ctx.fillStyle = color || c.accent;
  ctx.fillRect(0, y + 8, 3, Math.max(6, rowH - 17));
  ctx.fillStyle = c.text;
  const nameMax = headW - 74 - (swatch ? swatch.w + 12 : 0);
  const name = clipText(ctx, track.name || '(未命名)', Math.max(40, nameMax));
  ctx.fillText(name, 12, y + rowH / 2 - 5);
  ctx.fillStyle = c.muted;
  ctx.font = '10px "Segoe UI", system-ui, sans-serif';
  ctx.fillText(kindText[track.kind] || track.kind, 12, y + rowH / 2 + 11);

  if (swatch) {
    // 色卡：自定色实心；没自定就半透明（= 跟随主题的默认片段色）
    ctx.globalAlpha = color ? 1 : 0.42;
    roundRectPath(ctx, swatch.x, swatch.y, swatch.w, swatch.h, 3);
    ctx.fillStyle = color || c.midi;
    ctx.fill();
    ctx.globalAlpha = 1;
    ctx.lineWidth = 1;
    ctx.strokeStyle = color ? c.text : c.border;
    ctx.stroke();
  }
}

function drawClip(ctx, view, clip, rowY, sx, w, c, state, ti, hits, fx) {
  const rowH = view.rowH;
  const x0 = tickToX(view, clip.startTick) - sx;
  const x1 = tickToX(view, clip.startTick + clip.lengthTick) - sx;
  if (x1 < view.headW || x0 > w) return;

  const y = rowY + CLIP_PAD;
  const hgt = Math.max(6, rowH - CLIP_PAD * 2 - 1);
  const left = Math.max(x0, view.headW - 1);
  const right = Math.min(x1, w);
  const base = trackHex(state, view, ti) || clipKindHex(c, clip);

  // 播放头刚进入这个片段 → 整块亮一下，左缘有一道流光
  const hit = (fx.on !== false && fx.clip !== false && hits) ? (hits.get(clipHitKey(ti, clip.startTick)) || 0) : 0;
  const k = fx.strength || 1;

  ctx.save();
  ctx.beginPath();
  ctx.rect(left, y, Math.max(1, right - left), hgt);
  ctx.clip();

  ctx.globalAlpha = 0.16 + hit * 0.36 * k;
  ctx.fillStyle = base;
  ctx.fillRect(x0, y, Math.max(1, x1 - x0), hgt);
  ctx.globalAlpha = 1;

  if (hit > 0) {
    const g = ctx.createLinearGradient(x0, 0, x0 + 150 * k, 0);
    g.addColorStop(0, hexA(base, 0.75 * hit * k));
    g.addColorStop(1, hexA(base, 0));
    ctx.fillStyle = g;
    ctx.fillRect(x0, y, 150 * k, hgt);
  }

  ctx.strokeStyle = base;
  ctx.shadowColor = hit > 0 ? hexA(base, 0.9) : 'transparent';
  ctx.shadowBlur = hit * 20 * k;
  ctx.strokeRect(Math.round(x0) + 0.5, y + 0.5, Math.max(1, x1 - x0 - 1), hgt - 1);
  ctx.shadowBlur = 0;
  ctx.shadowColor = 'transparent';

  if (clip.kind === 'midi' && clip.notes && clip.notes.length) {
    drawNotes(ctx, view, clip, x0, y, hgt, c, base, hits, fx);
  } else if (clip.kind === 'audio') {
    // 假波形只给音频片段画：自动化片段没有波形，画上去是编的
    ctx.fillStyle = base;
    ctx.globalAlpha = 0.7 + hit * 0.3;
    for (let i = 0; i < 40; i++) {
      const px = x0 + 2 + i * 3;
      if (px > x1 - 2) break;
      const amp = 3 + Math.abs(Math.sin(i * 1.7)) * (hgt / 2 - 6);
      ctx.fillRect(px, y + hgt / 2 - amp, 1.5, amp * 2);
    }
    ctx.globalAlpha = 1;
  }

  ctx.restore();

  // 片段名：可在顶栏关掉（录制干净走带时不显示）
  if (state.showClipNames !== false && right - left > 34) {
    ctx.font = '10px "Segoe UI", "Microsoft YaHei", system-ui, sans-serif';
    ctx.fillStyle = c.text;
    ctx.globalAlpha = 0.9;
    ctx.fillText(clipText(ctx, clip.name || '', right - left - 8), left + 4, y + 10);
    ctx.globalAlpha = 1;
  }
}

/* ------------------------------------------------------ 用户音频轨（走带） */

const AUDIO_FONT = '12px "Segoe UI", "Microsoft YaHei", system-ui, sans-serif';
const AUDIO_FONT_SMALL = '10px "Segoe UI", "Microsoft YaHei", system-ui, sans-serif';

// 一个小的胶囊按钮（标题条上的那些）：框由 audioBarRects 给，这里只管画
function drawAudioChip(ctx, box, label, c, on) {
  roundRectPath(ctx, box.x, box.y, box.w, box.h, 4);
  ctx.fillStyle = on ? c.accent : c.bg;
  ctx.fill();
  ctx.lineWidth = 1;
  ctx.strokeStyle = on ? c.accent : c.border;
  ctx.stroke();
  ctx.fillStyle = on ? c.bg : c.text;
  ctx.textAlign = 'center';
  ctx.fillText(label, box.x + box.w / 2, box.y + box.h / 2 + 0.5);
  ctx.textAlign = 'left';
}

// 音频区标题条：左边一句统计，右边三个按钮（导入 / 加一轨 / 吸附）
function drawAudioBar(ctx, view, state, c, w, sy, headW) {
  const boxes = audioBarRects(view, sy);
  if (!boxes) return;
  const lanes = view.audioLanes || [];
  const clips = lanes.reduce((a, l) => a + (l.clips || []).length, 0);
  const y = rulerH - sy;

  ctx.font = AUDIO_FONT_SMALL;
  ctx.textBaseline = 'middle';
  ctx.fillStyle = c.audio;
  ctx.fillRect(0, y, 3, AUDIO_HEAD_H - 1);
  ctx.fillStyle = c.text;
  ctx.fillText(`音频轨 ${lanes.length} 条 · ${clips} 段`, 12, y + AUDIO_HEAD_H / 2);

  drawAudioChip(ctx, boxes.import, '导入音频', c, false);
  drawAudioChip(ctx, boxes.add, '加一轨', c, false);
  drawAudioChip(ctx, boxes.snap, state.audioSnap ? '吸附 开' : '吸附 关', c, !!state.audioSnap);
  if (state.audioSaving) {
    const last = boxes.snap.x + boxes.snap.w;
    ctx.fillStyle = c.muted;
    ctx.fillText('保存中…', last + 10, y + AUDIO_HEAD_H / 2);
  }

  const hint = state.audioAvailable ? '拖音频文件进来 或 点「导入音频」' : '音频轨要连本地服务才有';
  ctx.textAlign = 'right';
  ctx.fillStyle = c.muted;
  ctx.fillText(hint, w - 12, y + AUDIO_HEAD_H / 2);
  ctx.textAlign = 'left';
}

// 音频轨的轨道头：色条 + 名字 + 段数 + 静音 / 删除按钮
function drawAudioHead(ctx, lane, y, c, headW, rowH, rects, muted) {
  ctx.textBaseline = 'middle';
  ctx.fillStyle = muted ? c.muted : c.audio;
  ctx.fillRect(0, y + 8, 3, Math.max(6, rowH - 17));
  ctx.font = AUDIO_FONT;
  ctx.fillStyle = muted ? c.muted : c.text;
  const nameMax = headW - (rects ? 12 + rects.mute.w + AUDIO_HEAD_BTN_GAP + rects.del.w + 14 : 76);
  ctx.fillText(clipText(ctx, lane.name || '音频轨', Math.max(40, nameMax)), 12, y + rowH / 2 - 5);
  ctx.font = AUDIO_FONT_SMALL;
  ctx.fillStyle = c.muted;
  const n = (lane.clips || []).length;
  ctx.fillText(`${n} 段${muted ? ' · 已静音' : ''}`, 12, y + rowH / 2 + 11);

  if (rects) {
    drawAudioChip(ctx, rects.mute, 'M', c, !!muted);
    drawAudioChip(ctx, rects.del, '×', c, false);
  }
}

// 波形：按可见像素列从峰值桶里取 min/max 画竖线（一列扫原始样本会卡）
function drawAudioWave(ctx, rect, clip, info, color) {
  const peaks = info.peaks;
  const dur = info.durSec || 1;
  const f0 = clip.srcOffsetSec / dur;
  const f1 = (clip.srcOffsetSec + clip.lengthSec) / dur;
  const mid = rect.y + rect.h / 2;
  const amp = Math.max(2, rect.h / 2 - 3);
  const span = Math.max(1, rect.x1 - rect.x0);
  ctx.fillStyle = color;
  for (let px = rect.left; px < rect.right; px++) {
    const a = f0 + (f1 - f0) * ((px - rect.x0) / span);
    const b = f0 + (f1 - f0) * ((px + 1 - rect.x0) / span);
    const [lo, hi] = peakRange(peaks, Math.min(a, b), Math.max(a, b));
    const top = mid - hi * amp;
    const bottom = mid - lo * amp;
    ctx.fillRect(px, top, 1, Math.max(1, bottom - top));
  }
  // 零线：安静段也读得出来"这里有内容"
  ctx.fillStyle = hexA(color, 0.5);
  ctx.fillRect(rect.left, Math.round(mid), Math.max(0, rect.right - rect.left), 1);
}

function drawAudioClip(ctx, view, lane, clip, rowY, sx, w, c, state) {
  // 矩形自己就带滚动量（和命中判定同一套坐标），这里别再去减 sx
  const r = audioClipRect(view, lane, clip, state.scrollY, state, sx);
  const x0 = r.x0;
  const x1 = r.x1;
  if (x1 < view.headW || x0 > w) return;

  const hgt = r.h;
  const y = rowY + CLIP_PAD;
  const left = Math.max(x0, view.headW - 1);
  const right = Math.min(x1, w);
  const base = c.audio;
  const muted = !!lane.muted;
  const info = (typeof audioEngine !== 'undefined') ? audioEngine.info(clip.file) : null;
  const err = (typeof audioEngine !== 'undefined') ? audioEngine.error(clip.file) : '';
  const drag = state.audioDrag;
  const li = view.audioLanes.indexOf(lane);
  const active = !!(drag && drag.lane === li && drag.clip === (lane.clips || []).indexOf(clip));

  ctx.save();
  ctx.beginPath();
  ctx.rect(left, y, Math.max(1, right - left), hgt);
  ctx.clip();

  ctx.globalAlpha = muted ? 0.10 : (active ? 0.42 : 0.28);
  ctx.fillStyle = base;
  ctx.fillRect(x0, y, Math.max(1, x1 - x0), hgt);
  ctx.globalAlpha = 1;

  const wave = { x0, x1, y, h: hgt, left, right };
  if (info && !muted) {
    drawAudioWave(ctx, wave, clip, info, mixHex(base, c.text, 0.3));
  } else if (err) {
    // 文件读不到（工程目录被挪走 / 手工删了 media）：画斜纹，别画假波形
    ctx.strokeStyle = c.muted;
    ctx.lineWidth = 1;
    for (let px = left - hgt; px < right; px += 9) {
      ctx.beginPath();
      ctx.moveTo(px, y + hgt);
      ctx.lineTo(px + hgt, y);
      ctx.stroke();
    }
  } else if (!muted) {
    ctx.fillStyle = c.muted;
    ctx.font = AUDIO_FONT_SMALL;
    ctx.textBaseline = 'middle';
    if (right - left > 60) ctx.fillText('载入波形…', left + 6, y + hgt / 2 + 1);
  }

  // 边框：拖动中的片段加粗提亮
  ctx.strokeStyle = muted ? c.muted : (active ? mixHex(base, c.text, 0.45) : base);
  ctx.lineWidth = active ? 2 : 1.5;
  ctx.strokeRect(Math.round(x0) + 0.5, y + 0.5, Math.max(1, x1 - x0 - 1), hgt - 1);

  // 裁剪手柄：鼠标悬在片段上（或正在拖它）才画，免得平时一堆竖条
  const hover = state.audioHover;
  const hov = !!(hover && hover.lane === li && hover.clip === (lane.clips || []).indexOf(clip));
  if ((hov || active) && !muted) {
    ctx.fillStyle = hexA(mixHex(base, c.text, 0.6), active ? 0.9 : 0.55);
    ctx.fillRect(x0, y + 1, 2, hgt - 2);
    ctx.fillRect(x1 - 2, y + 1, 2, hgt - 2);
  }
  ctx.restore();

  // 名字 + 时长（压在片段上）
  if (right - left > 34 && hgt > 18) {
    ctx.font = AUDIO_FONT_SMALL;
    ctx.textBaseline = 'middle';
    ctx.fillStyle = muted ? c.muted : c.text;
    ctx.globalAlpha = 0.92;
    const len = `${clip.lengthSec.toFixed(2)}s`;
    const label = `${clipText(ctx, clip.name || '', Math.max(20, right - left - 46))} · ${len}`;
    ctx.fillText(label, left + 4, y + 10);
    ctx.globalAlpha = 1;
  }

  // 拖动时的读数：精确对齐全靠它（秒 + 小节.拍）
  if (active && drag && drag.readout) {
    ctx.font = AUDIO_FONT_SMALL;
    ctx.textBaseline = 'middle';
    const tw = ctx.measureText(drag.readout).width + 12;
    const bx = Math.max(view.headW + 2, Math.min(w - tw - 2, (x0 + x1) / 2 - tw / 2));
    const by = y + hgt + 3;
    ctx.fillStyle = c.panel;
    roundRectPath(ctx, bx, by, tw, 16, 4);
    ctx.fill();
    ctx.strokeStyle = c.accent;
    ctx.lineWidth = 1;
    ctx.stroke();
    ctx.fillStyle = c.text;
    ctx.fillText(drag.readout, bx + 6, by + 8);
  }
}

// 拖放定位线：文件拖到画布上时，标出"松手会放在哪个位置"
function drawAudioDropMark(ctx, view, state, c, h) {
  const drop = state.audioDrop;
  if (!drop || !(view.audioLanes || []).length) return;
  const x = Math.round(tickToX(view, drop.tick) - state.scrollX) + 0.5;
  if (x < view.headW || x > 100000) return;
  ctx.save();
  ctx.beginPath();
  ctx.rect(view.headW, rulerH, Math.max(0, 4000), h - rulerH);
  ctx.clip();
  ctx.strokeStyle = c.accent;
  ctx.lineWidth = 2;
  ctx.setLineDash([4, 3]);
  ctx.beginPath();
  ctx.moveTo(x, audioLaneTop(view, 0));
  ctx.lineTo(x, audioRowsBottom(view) + Math.min(view.tracks.length, 6) * view.rowH);
  ctx.stroke();
  ctx.setLineDash([]);
  ctx.restore();
}


// 网格（小节/拍线）+ 顶部标尺：走带与钢琴窗共用
function drawGridAndRuler(ctx, view, sx, w, h, c, headW) {
  // 可见范围是内容坐标 [sx, sx+w] —— 必须加上 sx。
  // 只按 [0, w] 算的话，横向滚动后视口右侧那一条会没有网格；
  // 缩得越小 tick 范围越大、越看不出来，所以只在放大后滚动时才暴露。
  const tick0 = xToTick(view, sx);
  const tick1 = xToTick(view, sx + w);
  // 线太密就只画小节线（缩放很小时不然是一堵墙，也省性能）
  const step = view.beatTicks * view.pxPerTick < 6 ? view.barTicks : view.beatTicks;
  const firstBeat = Math.floor(tick0 / step) * step;
  if (!exportMode) {                 // 导出模式：一根网格线都不画
    for (let t = firstBeat; t <= tick1; t += step) {
      const x = Math.round(tickToX(view, t) - sx) + 0.5;
      if (x < headW - 1 || x > w) continue;
      const isBar = Math.abs(t % view.barTicks) < 1e-6;
      ctx.strokeStyle = isBar ? c.grid : c.gridBeat;
      ctx.beginPath();
      ctx.moveTo(x, rulerH);
      ctx.lineTo(x, h);
      ctx.stroke();
    }
  }

  if (rulerH <= 0) return;           // 标尺被藏起来（导出模式），后面全是标尺的活

  ctx.fillStyle = c.panel;
  ctx.fillRect(0, 0, w, rulerH);
  ctx.fillStyle = c.border;
  ctx.fillRect(0, rulerH - 1, w, 1);
  ctx.font = '11px "Segoe UI", system-ui, sans-serif';
  ctx.textBaseline = 'middle';
  const firstBar = Math.floor(tick0 / view.barTicks) * view.barTicks;
  // 小节太窄时隔几小节标一个数字，不然挤成一团
  const barPx = view.barTicks * view.pxPerTick;
  const labelEvery = Math.max(1, Math.ceil(46 / Math.max(1, barPx)));
  for (let t = firstBar; t <= tick1; t += view.barTicks * labelEvery) {
    const x = Math.round(tickToX(view, t) - sx) + 0.5;
    if (x < headW || x > w) continue;
    ctx.strokeStyle = c.muted;
    ctx.beginPath();
    ctx.moveTo(x, rulerH - 9);
    ctx.lineTo(x, rulerH - 1);
    ctx.stroke();
    ctx.fillStyle = c.muted;
    ctx.fillText(String(Math.floor(t / view.barTicks) + 1), x + 4, rulerH / 2 - 1);
  }
}

/* -------------------------------------------------------------- 钢琴窗 */

function drawMidiRoll(ctx, view, state, c, w, h, hits, fx) {
  const sx = state.scrollX;
  const sy = state.scrollY;
  const headW = view.headW;
  const semiH = view.semiH;
  const lo = view.pitchLo;
  const hi = view.pitchHi;
  const yOf = (p) => rulerH + (hi - p) * semiH - sy;
  const k = fx.strength || 1;
  // 下部的控制器栏（力度 / CC）：音符区让出它们占的高度
  const lay = laneLayout(view, h);
  const noteBottom = lay.total ? lay.top : h;

  // 半音底色：黑键行压暗、C 音行稍亮，八度处一条分隔线
  for (let p = hi; p >= lo; p--) {
    const y = yOf(p);
    if (y > h || y + semiH < rulerH) continue;
    const pc = p % 12;
    ctx.fillStyle = BLACK_KEYS.has(pc) ? c.gridBeat : (pc === 0 ? c.panel : c.bg);
    ctx.fillRect(0, y, w, semiH);
    if (pc === 0 && !exportMode) {
      ctx.fillStyle = c.border;
      ctx.fillRect(headW, y + semiH - 1, Math.max(0, w - headW), 1);
    }
  }

  drawGridAndRuler(ctx, view, sx, w, h, c, headW);

  // 音符：轨道自定色优先；没自定就按轨道在 note 色与 accent 色之间取中间色，多轨能分辨
  const trackColor = (ti) => {
    const own = trackHex(state, view, ti);
    if (own) return own;
    const list = view.noteTracks || [];
    const idx = list.indexOf(ti);
    if (list.length <= 1 || idx < 0) return c.note;
    return mixHex(c.note, c.accent, idx / Math.max(1, list.length - 1));
  };
  const nh = Math.max(3, semiH - 2);

  // 音符区裁剪：音符滚出左边界时应该被自然裁掉，
  // 不能"顶"在键栏边上（旧写法把左缘 clamp 到 headW，长音符会一直贴着键栏直到 note-off）
  ctx.save();
  ctx.beginPath();
  ctx.rect(headW, rulerH, Math.max(0, w - headW), Math.max(0, noteBottom - rulerH));
  ctx.clip();

  for (const n of view.notes) {
    const nx = tickToX(view, n.tick) - sx;
    const nw = Math.max(2, n.lengthTick * view.pxPerTick);
    const ny = yOf(n.pitch);
    if (nx + nw < headW || nx > w || ny > h || ny + nh < rulerH) continue;
    const base = trackColor(n.track);
    ctx.globalAlpha = 0.45 + (n.velocity / 127) * 0.55;
    ctx.fillStyle = base;
    ctx.fillRect(nx, ny + 1, nw, nh);

    if (fx.on !== false && fx.note !== false) {
      const hit = hits.get(noteHitKey(n.pitch, n.tick)) || 0;
      if (hit > 0) {
        ctx.save();
        ctx.globalAlpha = Math.min(1, 0.55 + hit * 0.45);
        ctx.fillStyle = mixHex(base, '#ffffff', 0.7 * hit);
        ctx.shadowColor = hexA(base, 0.95);
        ctx.shadowBlur = 18 * hit * k;
        const grow = 2 * hit * k;
        ctx.fillRect(nx - grow, ny + 1 - grow, nw + grow * 2, nh + grow * 2);
        ctx.restore();
      }
    }
  }
  ctx.globalAlpha = 1;
  ctx.restore();

  // 左侧钢琴键栏（干净模式下 headW=0，整块不画）
  // 同样裁到标尺以下：键条跟着滚动上来时，半截键不许盖在标尺上
  if (headW > 0) {
    ctx.save();
    ctx.beginPath();
    ctx.rect(0, rulerH, headW, Math.max(0, noteBottom - rulerH));
    ctx.clip();
    drawPianoKeys(ctx, view, yOf, c, headW, h);
    ctx.restore();
  }

  // 控制器栏盖在音符区下面（不透明），播放头最后画、压在栏上穿过去
  if (lay.total) drawLanes(ctx, view, state, c, w, h, lay);

  const px = Math.round(tickToX(view, state.playheadTick) - sx) + 0.5;
  if (px >= headW && px <= w) drawPlayhead(ctx, c, px, h, state, fx, headW, w);
}

/* ------------------------------------------------- 下部控制器栏（v0.3） */

// 栏位排版：从视口底部往上摞，音符区至少留 60px（栏太多时会被挤扁）
function laneLayout(view, h) {
  const lanes = (view.mode === 'midi' && view.lanes) ? view.lanes : [];
  if (!lanes.length) return { total: 0, top: h, boxes: [] };
  let total = 0;
  for (const l of lanes) total += l.h + LANE_HEAD_H;
  const top = Math.max(rulerH + 60, h - total);
  let y = top;
  const boxes = lanes.map((lane) => {
    const box = { lane, y, h: lane.h };
    y += lane.h + LANE_HEAD_H;
    return box;
  });
  return { total, top, boxes };
}

function laneLabelText(view, lane) {
  if (lane.kind === 'velocity') return '力度';
  const name = (view.ccNames || {})[lane.cc];
  return `CC${lane.cc}${name && name !== `CC${lane.cc}` ? ' ' + name : ''}`;
}

function drawLanes(ctx, view, state, c, w, h, lay) {
  const sx = state.scrollX;
  const headW = view.headW;
  const tick0 = xToTick(view, sx);
  const tick1 = xToTick(view, sx + w);
  const step = view.beatTicks * view.pxPerTick < 6 ? view.barTicks : view.beatTicks;
  const firstBeat = Math.floor(tick0 / step) * step;

  ctx.fillStyle = c.panel;
  ctx.fillRect(0, lay.top, w, Math.max(0, h - lay.top));

  for (const box of lay.boxes) {
    const lane = box.lane;
    const yData = box.y + LANE_HEAD_H;
    const hData = Math.max(8, box.h);

    ctx.fillStyle = c.bg;
    ctx.fillRect(0, yData, w, hData);

    // 栏内竖网格：跟主网格同一条基准线（导出模式一起关掉）
    for (let t = firstBeat; !exportMode && t <= tick1; t += step) {
      const x = Math.round(tickToX(view, t) - sx) + 0.5;
      if (x < headW - 1 || x > w) continue;
      const isBar = Math.abs(t % view.barTicks) < 1e-6;
      ctx.strokeStyle = isBar ? c.grid : c.gridBeat;
      ctx.beginPath();
      ctx.moveTo(x, yData);
      ctx.lineTo(x, yData + hData);
      ctx.stroke();
    }

    // 中线（64）参考：CC 与力度都按 0..127 归一化，读图有个基准
    ctx.setLineDash([2, 3]);
    ctx.strokeStyle = c.grid;
    const yMid = yData + hData - hData * (64 / 127);
    ctx.beginPath();
    ctx.moveTo(headW, Math.round(yMid) + 0.5);
    ctx.lineTo(w, Math.round(yMid) + 0.5);
    ctx.stroke();
    ctx.setLineDash([]);

    ctx.save();
    ctx.beginPath();
    ctx.rect(headW, yData, Math.max(0, w - headW), hData);
    ctx.clip();
    if (lane.kind === 'velocity') drawVelocityLane(ctx, view, state, c, box, tick0, tick1);
    else drawCcLane(ctx, view, state, c, box, tick0, tick1);
    ctx.restore();

    // 标题条压在数据上（干净模式 headW=0 时也读得到栏名）
    ctx.fillStyle = c.panel;
    ctx.fillRect(0, box.y, w, LANE_HEAD_H);
    ctx.fillStyle = c.border;
    ctx.fillRect(0, box.y + LANE_HEAD_H - 1, w, 1);
    ctx.fillStyle = c.text;
    ctx.font = '10px "Segoe UI", "Microsoft YaHei", system-ui, sans-serif';
    ctx.textBaseline = 'middle';
    ctx.fillText(laneLabelText(view, lane), 8, box.y + LANE_HEAD_H / 2);
  }

  ctx.fillStyle = c.border;
  ctx.fillRect(0, lay.top, w, 1);
}

// 力度：每个音符一根柱，柱高 = velocity / 127
function drawVelocityLane(ctx, view, state, c, box, tick0, tick1) {
  const sx = state.scrollX;
  const y0 = box.y + LANE_HEAD_H;
  const hData = Math.max(8, box.h);
  const bw = Math.max(2, Math.min(7, view.pxPerTick * 24));   // 柱宽跟着缩放走，缩太小就保持 2px
  ctx.fillStyle = c.accent;
  for (const n of view.notes) {
    if (n.tick > tick1 || n.tick + n.lengthTick < tick0) continue;
    const x = tickToX(view, n.tick) - sx;
    const v = Math.max(0, Math.min(127, n.velocity || 0)) / 127;
    const bh = Math.max(1, hData * v);
    ctx.fillRect(x, y0 + hData - bh, bw, bh);
  }
}

// CC：阶梯折线（MIDI CC 是保持值，不是斜坡；踏板 0/127 这样最清楚）
function drawCcLane(ctx, view, state, c, box, tick0, tick1) {
  const sx = state.scrollX;
  const y0 = box.y + LANE_HEAD_H;
  const hData = Math.max(8, box.h);
  const lane = box.lane;
  const entry = (view.ccs || []).find((e) => e.cc === lane.cc);
  if (!entry || !entry.points.length) return;
  const pts = entry.points;
  const yOf = (v) => y0 + hData - Math.max(0, Math.min(127, v)) / 127 * hData;

  let lo = 0;
  let hi = pts.length - 1;
  let start = pts.length;
  while (lo <= hi) {                       // 第一个 tick >= tick0 的点
    const mid = (lo + hi) >> 1;
    if (pts[mid][0] >= tick0) { start = mid; hi = mid - 1; } else lo = mid + 1;
  }
  const from = Math.max(0, start - 1);     // 往前多取一个，左边缘有值

  ctx.strokeStyle = c.accent;
  ctx.lineWidth = 1.5;
  ctx.beginPath();
  let prevY = null;
  let started = false;
  for (let i = from; i < pts.length; i++) {
    const tick = pts[i][0];
    const x = tickToX(view, tick) - sx;
    const y = yOf(pts[i][1]);
    if (!started) { ctx.moveTo(x, y); started = true; }
    else { ctx.lineTo(x, prevY); ctx.lineTo(x, y); }
    prevY = y;
    if (tick > tick1) break;
  }
  ctx.stroke();
  ctx.lineWidth = 1;
}

function drawPianoKeys(ctx, view, yOf, c, headW, h) {
  const semiH = view.semiH;
  ctx.fillStyle = c.panel;
  ctx.fillRect(0, rulerH, headW, h - rulerH);

  for (let p = view.pitchHi; p >= view.pitchLo; p--) {
    const y = yOf(p);
    if (y > h || y + semiH < rulerH) continue;
    const pc = p % 12;
    const black = BLACK_KEYS.has(pc);
    // 白键：浅色条；黑键：深色短条
    ctx.fillStyle = black ? c.gridBeat : c.text;
    ctx.globalAlpha = black ? 0.9 : 0.82;
    ctx.fillRect(black ? 0 : 0, y + 1, black ? headW * 0.62 : headW - 6, semiH - 2);
    ctx.globalAlpha = 1;
    if (pc === 0) {                        // C 音标名字（C4 = 60）
      ctx.fillStyle = black ? c.text : c.bg;
      ctx.font = '9px "Segoe UI", system-ui, sans-serif';
      ctx.textBaseline = 'middle';
      ctx.fillText(pitchName(p), headW - 30, y + semiH / 2);
    }
  }

  ctx.fillStyle = c.panel;
  ctx.fillRect(0, 0, headW, rulerH);
  ctx.fillStyle = c.border;
  ctx.fillRect(headW - 1, 0, 1, h);
  ctx.fillStyle = c.muted;
  ctx.font = '11px "Segoe UI", "Microsoft YaHei", system-ui, sans-serif';
  ctx.textBaseline = 'middle';
  ctx.fillText('音高', 12, rulerH / 2 - 1);
}

function drawNotes(ctx, view, clip, x0, y, hgt, c, base, hits, fx) {
  const span = Math.max(1, view.pitchHi - view.pitchLo);
  const pad = 3;
  const usable = hgt - pad * 2;
  const nh = Math.max(2, usable / 22);
  const k = (fx && fx.strength) || 1;
  const noteCol = base || c.note;      // 轨道自定色优先
  const flashOn = fx && fx.on !== false && fx.note !== false && hits;
  for (const n of clip.notes) {
    const nx = x0 + n.startTick * view.pxPerTick;
    const nw = Math.max(1.5, n.lengthTick * view.pxPerTick);
    const rel = (n.pitch - view.pitchLo) / span;
    const ny = y + pad + (1 - rel) * (usable - 2);
    ctx.globalAlpha = 0.35 + (n.velocity / 127) * 0.6;
    ctx.fillStyle = noteCol;         // 每个音符都设一次：闪光块会改 fillStyle
    ctx.fillRect(nx, ny, nw, nh);

    // 播放头刚扫过 → 音符闪一下（提亮 + 外发光 + 一圈光点晕）
    if (flashOn) {
      const h = hits.get(noteHitKey(n.pitch, clip.startTick + n.startTick)) || 0;
      if (h > 0) {
        ctx.save();
        ctx.globalAlpha = Math.min(1, 0.5 + h * 0.5);
        ctx.fillStyle = mixHex(noteCol, '#ffffff', 0.8 * h);
        ctx.shadowColor = hexA(noteCol, 0.95);
        ctx.shadowBlur = 22 * h * k;
        const grow = 1.5 * h * k;
        ctx.fillRect(nx - grow, ny - grow, nw + grow * 2, nh + grow * 2);

        // 音符很小时（走带视图里只有 2px 高）单靠提亮看不出来，
        // 再点一圈光晕，静帧和录屏里都读得出"这里被扫到了"。
        // 注意：渐变 fillStyle 必须留在 save/restore 里，
        // 否则会粘到后面的音符上（渐变中心在别处 → 那些音符被画成透明）
        const cx = nx + nw / 2;
        const cy = ny + nh / 2;
        const rr = (5 + 6 * h) * k;
        const rg = ctx.createRadialGradient(cx, cy, 0, cx, cy, rr);
        rg.addColorStop(0, hexA('#ffffff', 0.6 * h));
        rg.addColorStop(0.4, hexA(noteCol, 0.5 * h));
        rg.addColorStop(1, hexA(noteCol, 0));
        ctx.shadowBlur = 0;
        ctx.fillStyle = rg;
        ctx.fillRect(cx - rr, cy - rr, rr * 2, rr * 2);
        ctx.restore();
      }
    }
  }
  ctx.globalAlpha = 1;
}

function clipText(ctx, text, maxWidth) {
  if (ctx.measureText(text).width <= maxWidth) return text;
  let s = text;
  while (s.length > 1 && ctx.measureText(s + '…').width > maxWidth) s = s.slice(0, -1);
  return s + '…';
}

if (typeof module !== 'undefined') {
  module.exports = {
    tickToX, xToTick, contentSize, barLabel, rowTop, pitchName, mixHex,
    makeView, makeMidiView, ROW_H, HEAD_W, KEYS_W, SEMI_H, RULER_H,
    trackHex, trackSwatchRect, hitTrackSwatch, SWATCH_W, SWATCH_H, clipKindHex,
    laneLayout, laneLabelText, LANE_HEAD_H, LANE_MIN_H,
    setCanvasExportMode, getRulerH,
    // 用户音频区（走带视图）
    audioBarH, audioLaneTop, audioRowsBottom, audioLaneAt, audioBarRects, audioBarHit,
    audioHeadRects, audioHeadHit, audioClipRect, audioClipAt,
    AUDIO_HEAD_H, AUDIO_EDGE_W,
  };
}
