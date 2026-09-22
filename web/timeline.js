/* 时间线绘制：视口渲染（只画可见区域），滚动/缩放/播放都只是改状态后重画。
   坐标约定：所有 tick -> 像素换算都经 tickToX / xToTick，方便单独测试与替换。 */

const ROW_H = 44;         // 默认行高（Alt+滚轮可调）
const HEAD_W = 200;       // 默认轨道名栏宽（干净模式下为 0）
const RULER_H = 30;
const CLIP_PAD = 4;
const KEYS_W = 64;        // 钢琴窗左侧键栏宽
const SEMI_H = 14;        // 钢琴窗每个半音的行高（Alt+滚轮可调）
const SWATCH_W = 26;      // 轨道头右侧色卡按钮宽
const SWATCH_H = 16;
const SWATCH_MIN_HEAD = 96;   // 轨道栏窄于此就不画色卡（放不下）

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
  return {
    mode: 'arrange',
    ppq,
    barTicks: ppq * (sig[0] || 4),
    beatTicks: ppq,
    tracks: project.tracks || [],
    lengthTicks: Math.max(project.lengthTicks || 0, 1),
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
    }
  }
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
    ? RULER_H + (view.pitchHi - view.pitchLo + 1) * view.semiH + 8
    : RULER_H + view.tracks.length * view.rowH + 8;
  return {
    width: Math.max(widthPx, view.headW + view.lengthTicks * view.pxPerTick + 40),
    height,
  };
}

function tickToX(view, tick) { return view.headW + tick * view.pxPerTick; }
function xToTick(view, x) { return Math.max(0, (x - view.headW) / view.pxPerTick); }
function rowTop(view, index) { return RULER_H + index * view.rowH; }

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

  // 轨道行底色（含行分隔）
  for (let i = 0; i < view.tracks.length; i++) {
    const y = rowTop(view, i) - sy;
    if (y > h || y + rowH < RULER_H) continue;
    ctx.fillStyle = i % 2 ? c.panel : c.bg;
    ctx.fillRect(0, y, w, rowH);
    ctx.fillStyle = c.border;
    ctx.fillRect(0, y + rowH - 1, w, 1);
  }

  // 网格 + 标尺（两种视图共用）
  drawGridAndRuler(ctx, view, sx, w, h, c, headW);

  // 片段 + 轨道头一律裁到标尺以下：纵向滚动时压线那一行会有一半在标尺区域，
  // 旧写法只在"整行滚出"时 continue，压线的行会直接画进标尺里（穿透标尺）。
  ctx.save();
  ctx.beginPath();
  ctx.rect(0, RULER_H, w, h - RULER_H);
  ctx.clip();

  // 片段
  for (let i = 0; i < view.tracks.length; i++) {
    const y = rowTop(view, i) - sy;
    if (y > h || y + rowH < RULER_H) continue;
    for (const clip of view.tracks[i].clips || []) {
      drawClip(ctx, view, clip, y, sx, w, c, state, i, hits, fx);
    }
  }

  // 轨道名栏（钉在左侧，覆盖片段与网格）；干净模式下 headW=0 即整块不画
  if (headW > 0) {
    ctx.fillStyle = c.panel;
    ctx.fillRect(0, RULER_H, headW, h - RULER_H);
    ctx.fillStyle = c.border;
    ctx.fillRect(headW - 1, RULER_H, 1, h - RULER_H);
    for (let i = 0; i < view.tracks.length; i++) {
      const y = rowTop(view, i) - sy;
      if (y > h || y + rowH < RULER_H) continue;
      drawTrackHead(ctx, view.tracks[i], y, c, headW, rowH,
                    trackHex(state, view, i), trackSwatchRect(view, i, sy));
    }
  }
  ctx.restore();

  // 标尺左上角那格（它本来就在标尺里，画在裁剪之外）
  if (headW > 0) {
    ctx.fillStyle = c.panel;
    ctx.fillRect(0, 0, headW, RULER_H);
    ctx.fillStyle = c.border;
    ctx.fillRect(headW - 1, 0, 1, RULER_H);
    ctx.fillStyle = c.muted;
    ctx.fillText('轨道', 12, RULER_H / 2 - 1);
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
  for (let t = firstBeat; t <= tick1; t += step) {
    const x = Math.round(tickToX(view, t) - sx) + 0.5;
    if (x < headW - 1 || x > w) continue;
    const isBar = Math.abs(t % view.barTicks) < 1e-6;
    ctx.strokeStyle = isBar ? c.grid : c.gridBeat;
    ctx.beginPath();
    ctx.moveTo(x, RULER_H);
    ctx.lineTo(x, h);
    ctx.stroke();
  }

  ctx.fillStyle = c.panel;
  ctx.fillRect(0, 0, w, RULER_H);
  ctx.fillStyle = c.border;
  ctx.fillRect(0, RULER_H - 1, w, 1);
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
    ctx.moveTo(x, RULER_H - 9);
    ctx.lineTo(x, RULER_H - 1);
    ctx.stroke();
    ctx.fillStyle = c.muted;
    ctx.fillText(String(Math.floor(t / view.barTicks) + 1), x + 4, RULER_H / 2 - 1);
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
  const yOf = (p) => RULER_H + (hi - p) * semiH - sy;
  const k = fx.strength || 1;

  // 半音底色：黑键行压暗、C 音行稍亮，八度处一条分隔线
  for (let p = hi; p >= lo; p--) {
    const y = yOf(p);
    if (y > h || y + semiH < RULER_H) continue;
    const pc = p % 12;
    ctx.fillStyle = BLACK_KEYS.has(pc) ? c.gridBeat : (pc === 0 ? c.panel : c.bg);
    ctx.fillRect(0, y, w, semiH);
    if (pc === 0) {
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
  ctx.rect(headW, RULER_H, Math.max(0, w - headW), Math.max(0, h - RULER_H));
  ctx.clip();

  for (const n of view.notes) {
    const nx = tickToX(view, n.tick) - sx;
    const nw = Math.max(2, n.lengthTick * view.pxPerTick);
    const ny = yOf(n.pitch);
    if (nx + nw < headW || nx > w || ny > h || ny + nh < RULER_H) continue;
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
    ctx.rect(0, RULER_H, headW, Math.max(0, h - RULER_H));
    ctx.clip();
    drawPianoKeys(ctx, view, yOf, c, headW, h);
    ctx.restore();
  }

  const px = Math.round(tickToX(view, state.playheadTick) - sx) + 0.5;
  if (px >= headW && px <= w) drawPlayhead(ctx, c, px, h, state, fx, headW, w);
}

function drawPianoKeys(ctx, view, yOf, c, headW, h) {
  const semiH = view.semiH;
  ctx.fillStyle = c.panel;
  ctx.fillRect(0, RULER_H, headW, h - RULER_H);

  for (let p = view.pitchHi; p >= view.pitchLo; p--) {
    const y = yOf(p);
    if (y > h || y + semiH < RULER_H) continue;
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
  ctx.fillRect(0, 0, headW, RULER_H);
  ctx.fillStyle = c.border;
  ctx.fillRect(headW - 1, 0, 1, h);
  ctx.fillStyle = c.muted;
  ctx.font = '11px "Segoe UI", "Microsoft YaHei", system-ui, sans-serif';
  ctx.textBaseline = 'middle';
  ctx.fillText('音高', 12, RULER_H / 2 - 1);
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
  };
}
