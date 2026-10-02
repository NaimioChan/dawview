// dawview 前端验证 — 零依赖 CDP 驱动（Node ≥22）。
// 用法: node scripts/verify.mjs [--url http://127.0.0.1:8765/index.html] [--cdp http://127.0.0.1:9223]
import { writeFileSync, copyFileSync, existsSync, mkdirSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const arg = (flag, dflt) => {
  const i = process.argv.indexOf(flag);
  return i >= 0 ? process.argv[i + 1] : dflt;
};
const CDP = arg('--cdp', 'http://127.0.0.1:9223');
const TARGET = arg('--url', 'http://127.0.0.1:8765/index.html');
// 截图产物扔进 .cache/shots（仓库根目录只留代码与文档）
const shotDir = resolve(arg('--shot-dir', resolve(process.cwd(), '.cache', 'shots')));
mkdirSync(shotDir, { recursive: true });

// 数据快照：app 每次运行都会用当前打开的工程覆盖 web/project.json，
// 无头验证读的就是这个回退文件 —— 每次开测前把固定快照放回去，断言才不会随用户换工程而飘。
const here = dirname(fileURLToPath(import.meta.url));
const fixture = resolve(here, 'fixture-project.json');
const flFixture = resolve(here, 'fixture-project-fl.json');
// REAPER 快照（.rpp 是纯文本工程，秒 -> tick 的换算只有这份工程才验得了）
const reaperFixture = resolve(here, 'fixture-project-reaper.json');
// Bitwig 快照（.bwproject 是二进制容器 + "元素流"文档，音高存在音高轨上、
// 音频片段归属靠启发式 —— 这一段验的就是这些真的落进了契约与前端的画法）
const bitwigFixture = resolve(here, 'fixture-project-bitwig.json');
// Studio One 快照（.song 是 ZIP：XML 走带 + 二进制演奏文件，位置/长度两套单位
// 分开决定 —— 这一段验的就是这些真的落进了契约与前端的画法）
const studioOneFixture = resolve(here, 'fixture-project-studioone.json');
// MIDI 快照（.mid 是标准 MIDI 文件：变长量 delta + 运行状态；没有"片段"这一层，
// 解析器按"一条 MTrk = 一条轨、整条轨一个片段"进契约 —— 这一段验的就是这个映射）
const midiFixture = resolve(here, 'fixture-project-midi.json');
// 速度轨快照：任意"带复杂变速"的工程（.cpr/.flp 都行）。变速播放只有真·变速
// 工程才验得出来，所以单独一段；没有这个快照就跳过，不报错。
const tempoFixture = resolve(arg('--tempo-fixture', resolve(here, 'fixture-project-tempo.json')));
const live = resolve(here, '..', 'web', 'project.json');
if (existsSync(fixture) && TARGET.includes('8765')) {
  copyFileSync(fixture, live);
  console.log('• 已恢复数据快照 web/project.json（26.9.6 lulabi）');
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const withTimeout = (p, ms, label) =>
  Promise.race([p, new Promise((_, rej) => setTimeout(() => rej(new Error(`timeout: ${label}`)), ms))]);

const targets = await (await fetch(`${CDP}/json`)).json();
// 优先挑 --url 指向的那个页面：Edge 首次启动会额外开一个
// edge://sync-confirmation-dialog 页，挑错了整轮验证都跑在空页上
const pages = targets.filter((t) => t.type === 'page' && !t.url.startsWith('chrome://')
  && !t.url.startsWith('edge://'));
const page = pages.find((t) => t.url === TARGET || t.url.startsWith(TARGET.split('?')[0]))
  || pages[0];
if (!page) throw new Error('no page target (Edge 是否带 --remote-debugging-port 启动?)');
const ws = new WebSocket(page.webSocketDebuggerUrl);
await withTimeout(new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; }), 10_000, 'ws open');

let id = 0;
const pending = new Map();
ws.onmessage = (e) => {
  const m = JSON.parse(e.data);
  if (m.id && pending.has(m.id)) {
    const { res, rej } = pending.get(m.id);
    pending.delete(m.id);
    m.error ? rej(new Error(m.error.message)) : res(m.result);
  }
};
const send = (method, params = {}) =>
  withTimeout(new Promise((res, rej) => {
    const i = ++id;
    pending.set(i, { res, rej });
    ws.send(JSON.stringify({ id: i, method, params }));
  }), 12_000, method);
const evalJs = async (expression) => {
  const r = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
  if (r.exceptionDetails) throw new Error(r.exceptionDetails.text + ' :: ' +
    (r.exceptionDetails.exception?.description || ''));
  return r.result?.value;
};

// 关掉浏览器缓存：改了 web/*.js 后必须拿到新代码，否则测的是旧文件
await send('Network.enable');
await send('Network.setCacheDisabled', { cacheDisabled: true });
// 把目标页提到前面：headless Edge 起手会多开一个 edge://sync-confirmation-dialog 页，
// 我们的页面在后台（document.visibilityState = 'hidden'）时 rAF 被节流 ——
// 播放头不推进、Page.captureScreenshot 还会直接卡死（实测第 3 张必挂）。
await send('Page.bringToFront').catch(() => {});
const shot = async (file) => {
  try {
    const r = await withTimeout(send('Page.captureScreenshot', { format: 'png' }), 15_000,
                                'Page.captureScreenshot');
    writeFileSync(resolve(shotDir, file), Buffer.from(r.data, 'base64'));
    console.log(`  saved ${file}`);
  } catch (err) {
    console.log(`  (截图 ${file} 没拿到：${err.message} —— 不影响断言)`);
  }
};
const step = (l) => console.log(`• ${l}`);

// 真·鼠标/键盘事件：synthetic dispatchEvent 只证明"handler 绑上了"，
// 证明不了"真的点得到"（画布上盖了别的层时照样绿）
const clickAt = async (x, y) => {
  await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y });
  await send('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'left', clickCount: 1 });
  await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button: 'left', clickCount: 1 });
};
const rightClickAt = async (x, y) => {
  await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y });
  await send('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'right', clickCount: 1 });
  await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button: 'right', clickCount: 1 });
};
const keyPress = async (key, code, vk) => {
  await send('Input.dispatchKeyEvent', { type: 'keyDown', key, code, windowsVirtualKeyCode: vk });
  await send('Input.dispatchKeyEvent', { type: 'keyUp', key, code, windowsVirtualKeyCode: vk });
};

// 某条轨道色卡在视口里的中心点（CSS px）
// 注意要传 scrollY：色卡几何和绘制共用"已减纵向滚动量"的画布坐标
const swatchCenter = (vi) => evalJs(`(() => {
  const dv = window.dawview, c = document.getElementById('tl');
  const r = c.getBoundingClientRect();
  const s = trackSwatchRect(dv.state.view, ${vi}, dv.state.scrollY);
  return s ? { x: r.left + s.x + s.w / 2, y: r.top + s.y + s.h / 2 } : null;
})()`);

// 色卡图形中心的实际像素色（画布是 dpr 缩放的）
const swatchPixel = (vi) => evalJs(`(() => {
  const dv = window.dawview, c = document.getElementById('tl'), ctx = c.getContext('2d');
  const dpr = window.devicePixelRatio || 1;
  const s = trackSwatchRect(dv.state.view, ${vi}, dv.state.scrollY);
  const d = ctx.getImageData(Math.round((s.x + s.w / 2) * dpr), Math.round((s.y + s.h / 2) * dpr), 1, 1).data;
  return [d[0], d[1], d[2]];
})()`);

// 驱动 rAF 队列（后台标签不跑 rAF）
const DRIVE_RAF = (n) => `(() => {
  const cbs = [];
  const orig = window.requestAnimationFrame;
  window.requestAnimationFrame = (cb) => { cbs.push(cb); return cbs.length; };
  const t0 = performance.now();
  for (let i = 0; i < ${n}; i++) { const cb = cbs.shift(); if (cb) cb(t0 + i * 16.7); }
  window.requestAnimationFrame = orig;
  return cbs.length;
})()`;

const checks = [
  ['页面载入无异常', async () => {
    const st = await evalJs(`document.getElementById('status-text').textContent`);
    const empty = await evalJs(`document.getElementById('empty').hidden`);
    return { pass: empty === true && /轨道/.test(st), detail: st };
  }],

  ['工程元信息渲染', async () => {
    const t = await evalJs(`document.getElementById('proj-info').textContent`);
    return { pass: /76 BPM/.test(t) && /4\/4/.test(t) && /48000/.test(t), detail: t };
  }],

  ['轨道/片段/音符计数正确', async () => {
    const d = await evalJs(`(() => {
      const s = window.dawview.state;
      const clips = s.project.tracks.reduce((a,t)=>a+t.clips.length,0);
      const notes = s.project.tracks.reduce((a,t)=>a+t.clips.reduce((b,c)=>b+(c.notes?c.notes.length:0),0),0);
      return { tracks: s.project.tracks.length, clips, notes };
    })()`);
    return {
      pass: d.tracks === 4 && d.clips === 2 && d.notes === 191,
      detail: JSON.stringify(d),
    };
  }],

  ['画布真的画了东西', async () => {
    const r = await evalJs(`(() => {
      const c = document.getElementById('tl');
      const ctx = c.getContext('2d');
      const d = ctx.getImageData(0, 0, c.width, c.height).data;
      let lit = 0, colors = new Set();
      for (let i = 0; i < d.length; i += 4 * 37) {
        if (d[i+3] > 0) { lit++; colors.add(d[i]+','+d[i+1]+','+d[i+2]); }
      }
      return { lit, distinct: colors.size, w: c.width, h: c.height };
    })()`);
    return { pass: r.lit > 500 && r.distinct > 4, detail: JSON.stringify(r) };
  }],

  ['MIDI 片段内画了音符', async () => {
    // 音符是半透明叠加在片段底色上的细条 —— 用当前主题变量算出期望叠加色再比对
    const r = await evalJs(`(() => {
      const hex = (h) => {
        h = h.trim().replace('#','');
        return [parseInt(h.slice(0,2),16), parseInt(h.slice(2,4),16), parseInt(h.slice(4,6),16)];
      };
      const v = (n) => getComputedStyle(document.documentElement).getPropertyValue(n);
      const mix = (a, b, t) => a.map((x, i) => x + (b[i] - x) * t);
      const bg = hex(v('--bg')), midi = hex(v('--clip-midi')), note = hex(v('--note'));
      const fill = mix(bg, midi, 0.16);          // 片段底色
      const expect = mix(fill, note, 0.65);      // 音符平均透明度下的叠加色
      const c = document.getElementById('tl');
      const ctx = c.getContext('2d');
      const dpr = window.devicePixelRatio || 1;
      const x = Math.round(200 * dpr), w = Math.round(420 * dpr);
      const y = Math.round(30 * dpr), h = Math.round(44 * dpr);
      const d = ctx.getImageData(x, y, w, h).data;
      let hits = 0;
      for (let i = 0; i < d.length; i += 4) {
        const dist = Math.abs(d[i]-expect[0]) + Math.abs(d[i+1]-expect[1]) + Math.abs(d[i+2]-expect[2]);
        if (dist < 120) hits++;
      }
      return { hits, expect: expect.map(Math.round) };
    })()`);
    return { pass: r.hits > 20, detail: JSON.stringify(r) };
  }],

  ['走带播放推进 + 自动跟随滚动', async () => {
    await evalJs(`window.dawview.setPlaying(true)`);
    await evalJs(`window.__t0 = window.dawview.state.playheadTick`);
    for (let i = 0; i < 12; i++) {
      await evalJs(DRIVE_RAF(20));
      await sleep(60);
    }
    const r = await evalJs(`(() => {
      const s = window.dawview.state;
      return { t0: window.__t0, t1: s.playheadTick, playing: s.playing,
               scrollLeft: document.getElementById('scroll').scrollLeft,
               pos: document.getElementById('pos-label').textContent };
    })()`);
    await evalJs(`window.dawview.setPlaying(false)`);
    return { pass: r.t1 > r.t0 + 100, detail: JSON.stringify(r) };
  }],

  ['顶栏：位置串变长时不推挤播放控制', async () => {
    // 位置串宽度会随播放变化（"9.4.2 · 190.0 BPM" → "117.99.99 · 89.3 BPM"）。
    // 播放按钮若排在它右边，就会跟着左右抽搐 —— 这条用最坏情况串盯住几何。
    const r = await evalJs(`(() => {
      const el = document.getElementById('pos-label');
      const btn = document.getElementById('btn-play');
      const home = document.getElementById('btn-home');
      const keep = el.textContent;
      const x0 = btn.getBoundingClientRect().left;
      const h0 = home.getBoundingClientRect().left;
      el.textContent = '117.99.99 · 89.3 BPM';
      const x1 = btn.getBoundingClientRect().left;   // getBoundingClientRect 会强制重排
      const h1 = home.getBoundingClientRect().left;
      el.textContent = keep;
      return { x0: Math.round(x0), x1: Math.round(x1), h0: Math.round(h0), h1: Math.round(h1) };
    })()`);
    return { pass: r.x0 === r.x1 && r.h0 === r.h1, detail: JSON.stringify(r) };
  }],

  ['标尺点击可定位（横向滚动后也要准）', async () => {
    // 片段/音符是按内容坐标画的（画的时候减了 scrollX），点标尺定位必须先把滚动量加回去。
    // 老写法漏加 scrollX：内容一宽过视口（缩放 >100%）就有滚动量，点哪儿都偏左一个滚动量，
    // 看着像"只在某个缩放下定位错"。这里逐档对比"点下去的那一像素"和"播放头画在哪一像素"。
    const r = await evalJs(`(() => {
      const s = window.dawview.state;
      const scroll = document.getElementById('scroll');
      const el = document.getElementById('tl');
      const xToTick = (v, x) => Math.max(0, (x - v.headW) / v.pxPerTick);
      const tickToX = (v, t) => v.headW + t * v.pxPerTick;
      const keep = { px: s.pxPerTick, sx: s.scrollX, tick: s.playheadTick };
      const out = [];
      for (const [pxPerTick, want] of [[0.03, 0], [0.0444, 0], [0.0444, 400],
                                       [0.0444, 700], [0.12, 900]]) {
        window.dawview.applyZoomTo({ pxPerTick, anchorTick: 0, anchorFrac: 0 });
        scroll.scrollLeft = want;
        s.scrollX = scroll.scrollLeft;                 // 无头环境下滚动事件不一定及时
        window.dawview.paint();
        const rect = el.getBoundingClientRect();
        const clickX = 300 + (want ? 120 : 0);
        el.dispatchEvent(new MouseEvent('mousedown', { bubbles: true,
          clientX: rect.left + clickX, clientY: rect.top + 10 }));
        const drawn = tickToX(s.view, s.playheadTick) - s.scrollX;
        out.push({ pxPerTick, scrollLeft: s.scrollX, clickX,
                   tick: s.playheadTick,
                   wantTick: Math.round(xToTick(s.view, clickX + s.scrollX)),
                   dTick: s.playheadTick - Math.round(xToTick(s.view, clickX + s.scrollX)),
                   dPix: Math.round(drawn - clickX) });
      }
      window.dawview.applyZoomTo({ pxPerTick: keep.px, anchorTick: 0, anchorFrac: 0 });
      scroll.scrollLeft = keep.sx; s.scrollX = scroll.scrollLeft;
      s.playheadTick = keep.tick; window.dawview.paint();
      return { out, back: scroll.scrollLeft === keep.sx };
    })()`);
    const bad = r.out.filter((o) => Math.abs(o.dPix) > 2 || Math.abs(o.dTick) > 2);
    return { pass: r.out.length === 5 && bad.length === 0 && r.back,
             detail: JSON.stringify(r.out) + (bad.length ? ' 不合格档位=' + JSON.stringify(bad) : '') };
  }],

  ['缩放改变内容宽度', async () => {
    const before = await evalJs(`document.getElementById('spacer').style.width`);
    await evalJs(`document.getElementById('btn-zoom-in').click()`);
    await evalJs(`document.getElementById('btn-zoom-in').click()`);
    const after = await evalJs(`document.getElementById('spacer').style.width`);
    await evalJs(`document.getElementById('btn-fit').click()`);
    const fitW = await evalJs(`document.getElementById('spacer').style.width`);
    return {
      pass: parseFloat(after) > parseFloat(before) && parseFloat(fitW) > 0,
      detail: `${before} -> ${after} -> fit ${fitW}`,
    };
  }],

  ['主题切换改 CSS 变量 + 画布跟随', async () => {
    const r = await evalJs(`(() => {
      const sel = document.getElementById('theme-select');
      const read = (v) => getComputedStyle(document.documentElement).getPropertyValue(v).trim();
      const a1 = read('--accent'), b1 = read('--bg');
      sel.value = 'midnight';
      sel.dispatchEvent(new Event('change'));
      const a2 = read('--accent'), b2 = read('--bg');
      sel.value = 'aqua';
      sel.dispatchEvent(new Event('change'));
      const a3 = read('--accent');
      return { a1, a2, b1, b2, a3 };
    })()`);
    return {
      pass: r.a1 !== r.a2 && r.b1 !== r.b2 && r.a3 === r.a1,
      detail: JSON.stringify(r),
    };
  }],

  ['主题持久化到 localStorage', async () => {
    const r = await evalJs(`(() => {
      const sel = document.getElementById('theme-select');
      sel.value = 'forest';
      sel.dispatchEvent(new Event('change'));
      return localStorage.getItem('dawview.theme');
    })()`);
    const reloaded = await evalJs(`(() => {
      location.reload();
      return 'reloading';
    })()`);
    await sleep(1800);
    const r2 = await evalJs(`(() => ({
      stored: localStorage.getItem('dawview.theme'),
      accent: getComputedStyle(document.documentElement).getPropertyValue('--accent').trim(),
      sel: document.getElementById('theme-select').value,
    }))()`);
    return {
      pass: typeof r === 'string' && r.includes('forest') && r2.sel === 'forest'
            && r2.accent.toLowerCase() === '#5fa87a',
      detail: JSON.stringify({ r, r2, reloaded }),
    };
  }],

  ['导出模式：一键隐藏网格线 / 标尺 / 滚动条', async () => {
    const r = await evalJs(`(() => {
      const dv = window.dawview;
      const c = document.getElementById('tl'), g = c.getContext('2d');
      const sc = document.getElementById('scroll');
      // 横竖两种滚动条都算上：竖的看宽度差、横的看高度差
      const sbW = () => (sc.offsetWidth - sc.clientWidth) + (sc.offsetHeight - sc.clientHeight);
      const grab = () => g.getImageData(0, 0, c.width, c.height).data.slice();
      dv.setViewMode('arrange');
      // 先钉住缩放：内容必须比视口宽，才谈得上"滚动条被藏掉"。
      // 放开跑的话内容可能正好装得下（两种状态都没滚动条），这条就没法判断了。
      dv.state.showHeads = true;
      dv.state.pxPerTick = 0.2;
      dv.rebuildView(); dv.paint();
      const A = grab();
      const off = { rulerH: dv.getRulerH(), sb: sbW(), exp: dv.isExport(),
                    body: document.body.className, px: dv.state.pxPerTick,
                    size: [sc.scrollWidth, sc.clientWidth, sc.scrollHeight, sc.clientHeight],
                    heads: dv.state.showHeads };
      dv.setExportMode(true);
      const B = grab();
      let diff = 0;
      for (let i = 0; i < A.length; i += 4) {
        if (A[i] !== B[i] || A[i+1] !== B[i+1] || A[i+2] !== B[i+2]) diff++;
      }
      const on = { rulerH: dv.getRulerH(), sb: sbW(), exp: dv.isExport(),
                   body: document.body.className, diff };
      dv.setExportMode(false);
      dv.rebuildView(); dv.paint();
      const back = { rulerH: dv.getRulerH(), sb: sbW(), exp: dv.isExport(),
                     body: document.body.className,
                     size: [sc.scrollWidth, sc.clientWidth, sc.scrollHeight, sc.clientHeight] };
      return { off, on, back };
    })()`);
    return {
      pass: r.off.rulerH === 30 && r.off.sb > 0 && !r.off.exp
            && r.on.rulerH === 0 && r.on.sb === 0 && r.on.exp && r.on.body.includes('export')
            && r.on.diff > 3000            // 画面真的变了：网格 + 标尺都没了
            && r.back.rulerH === 30 && r.back.sb > 0 && !r.back.exp,
      detail: JSON.stringify(r),
    };
  }],

  ['设置记忆：导出模式 + 缩放写进 localStorage，重载后照旧', async () => {
    const saved = await evalJs(`(() => {
      const dv = window.dawview;
      dv.state.pxPerTick = 0.11; dv.rebuildView();   // 先改缩放
      dv.setExportMode(true);                        // 再开导出模式（这一步会落盘，把两者一起存）
      return JSON.parse(localStorage.getItem('dawview.view') || '{}');
    })()`);
    await evalJs(`(() => { location.reload(); return 'reloading'; })()`);
    await sleep(1800);
    const back = await evalJs(`(() => {
      const dv = window.dawview;
      return { exp: dv.isExport(), rulerH: dv.getRulerH(), body: document.body.className,
               px: dv.state.pxPerTick };
    })()`);
    const ok = saved.exportMode === true && Math.abs(saved.pxPerTick - 0.11) < 1e-9
               && back.exp === true && back.rulerH === 0 && back.body.includes('export')
               && Math.abs(back.px - 0.11) < 1e-9;
    await evalJs(`(() => { const dv = window.dawview; dv.setExportMode(false); return 1; })()`);
    await sleep(200);
    return { pass: ok, detail: JSON.stringify({ saved: { exportMode: saved.exportMode, pxPerTick: saved.pxPerTick }, back }) };
  }],

  ['配色主题：12 套（深 7 / 浅 5）变量齐全 + 对比度达标 + 切主题画布真的重画', async () => {
    const r = await evalJs(`(() => {
      const sel = document.getElementById('theme-select');
      const read = (v) => getComputedStyle(document.documentElement).getPropertyValue(v).trim();
      const NEED = ['--bg','--panel','--panel-2','--border','--grid','--grid-beat',
                    '--text','--muted','--accent','--clip-midi','--clip-audio','--clip-auto','--note'];
      const hex = (s) => {
        const m = /^#([0-9a-f]{6})$/i.exec(String(s).trim());
        return m ? [parseInt(m[1].slice(0,2),16), parseInt(m[1].slice(2,4),16), parseInt(m[1].slice(4,6),16)] : null;
      };
      const lin = (x) => { x /= 255; return x <= 0.03928 ? x/12.92 : Math.pow((x+0.055)/1.055, 2.4); };
      const lum = (p) => 0.2126*lin(p[0]) + 0.7152*lin(p[1]) + 0.0722*lin(p[2]);
      const cr = (a, b) => { const la = lum(a), lb = lum(b); return (Math.max(la,lb)+0.05)/(Math.min(la,lb)+0.05); };
      const mix = (a, b, t) => a.map((v, i) => Math.round(v*(1-t) + b[i]*t));
      const dist = (a, b) => Math.hypot(a[0]-b[0], a[1]-b[1], a[2]-b[2]);
      const groups = [...sel.querySelectorAll('optgroup')].map((g) => ({
        label: g.label, values: [...g.children].map((o) => o.value),
      }));
      const opts = [...sel.options].map((o) => o.value);
      const c = document.getElementById('tl'), ctx = c.getContext('2d');
      const px = (x, y) => { const d = ctx.getImageData(x, y, 1, 1).data; return [d[0], d[1], d[2]]; };
      // 取样点 1：轨道头面板是整列不透明填充，画布颜色必须与 --panel 完全一致
      const SX = Math.round(c.width * 0.08), SY = c.height - 30;
      // 取样点 2：内容区（走带第 0 行里，正好压在片段上）的像素。片段底色是
      // 主题色混出来的，不要求精确值，只要求"12 套主题给出 12 种不同颜色"
      // —— 证明内容区也跟着主题重画，而不是只有左侧面板变了。
      const mode = (arr) => {
        const m = new Map();
        for (const a of arr) m.set(a, (m.get(a) || 0) + 1);
        return [...m.entries()].sort((x, y) => y[1] - x[1])[0][0];
      };
      const BY = Math.round(52 * (window.devicePixelRatio || 1));   // 第 0 行（CSS y 30~74）的中间
      const bandPx = () => {
        const xs = [];
        for (const dx of [20, 60, 100])
          for (const dy of [-6, 0, 6])
            xs.push(px(c.width - dx, BY + dy).join(','));
        return mode(xs);
      };
      const rows = [];
      for (const v of opts) {
        sel.value = v;
        sel.dispatchEvent(new Event('change'));
        const missing = NEED.filter((n) => !hex((THEMES[v].vars || {})[n]));
        // 主题自己声明什么、页面上就必须是什么（inline style 会残留上一个主题的值，
        // 少写一个变量在 getComputedStyle 里看不出来 —— 必须和主题定义对一遍）
        const wrong = NEED.filter((n) => n !== '--accent'
          && read(n).toLowerCase() !== String(THEMES[v].vars[n]).toLowerCase());
        const P = (n) => hex(read(n)) || [0, 0, 0];
        const bg = P('--bg'), clip = mix(bg, P('--clip-midi'), 0.16);
        const t = (THEMES[v] || {});
        const sample = px(SX, SY), want = P('--panel');
        const row = {
          v, label: t.label, kind: t.kind, missing, wrong,
          text: +cr(P('--text'), bg).toFixed(2),
          muted: +cr(P('--muted'), bg).toFixed(2),
          accent: +cr(P('--accent'), bg).toFixed(2),
          note: +cr(P('--note'), bg).toFixed(2),
          midi: +cr(P('--clip-midi'), bg).toFixed(2),
          audio: +cr(P('--clip-audio'), bg).toFixed(2),
          auto: +cr(P('--clip-auto'), bg).toFixed(2),
          // 三种片段底色必须两两分得开：分不开的话走带上一眼认不出哪条是自动化
          clipDist: Math.round(Math.min(dist(P('--clip-midi'), P('--clip-audio')),
                                        dist(P('--clip-midi'), P('--clip-auto')),
                                        dist(P('--clip-audio'), P('--clip-auto')))),
          noteOnClip: +cr(mix(clip, P('--note'), 0.6), clip).toFixed(2),
          bgLum: +lum(bg).toFixed(3),
          panelOk: sample.join(',') === want.join(','),
          band: bandPx(),
        };
        row.kindOk = t.kind === 'dark' ? row.bgLum < 0.25 : row.bgLum > 0.6;
        row.distinctOk = row.clipDist >= 45;
        row.contrastOk = row.text >= 10 && row.muted >= 3.5 && row.accent >= 3
                         && row.note >= 4 && row.midi >= 3 && row.audio >= 2.8
                         && row.auto >= 3 && row.noteOnClip >= 2;
        rows.push(row);
      }
      sel.value = 'aqua';
      sel.dispatchEvent(new Event('change'));
      // 12 套主题的 --bg 两两不同 → 画布上行底色也应该有 12 种（每套都真的重画了）
      const bandSet = [...new Set(rows.map((r) => r.band))].length;
      return { groups, count: opts.length, rows, bandSet, restored: sel.value };
    })()`);
    const bad = r.rows.filter((x) => x.missing.length || x.wrong.length || !x.panelOk
                                     || !x.contrastOk || !x.kindOk || !x.distinctOk);
    const dark = r.rows.filter((x) => x.kind === 'dark').length;
    const light = r.rows.filter((x) => x.kind === 'light').length;
    return {
      pass: r.count === 12 && dark === 7 && light === 5
            && r.groups.length === 2 && r.groups[0].label === '深色' && r.groups[1].label === '浅色'
            && r.groups[0].values.length === 7 && r.groups[1].values.length === 5
            && r.restored === 'aqua' && r.bandSet === 12 && bad.length === 0,
      detail: JSON.stringify({ count: r.count, dark, light, bandSet: r.bandSet,
                               groups: r.groups.map((g) => g.label + ':' + g.values.length),
                               bad, rows: r.rows }),
    };
  }],

  ['页面不依赖 webui 桥 / 后端（静态打开也能跑）', async () => {
    // 以前这条检查是"注入假桥，断言桥优先"。改成本地服务之后没有桥了：
    // 断言页面里既没有 webui.js 也没有 window.webui，数据仍然从 project.json 来、
    // 界面照样渲染。同时验证没有后端时前端不会因为 /events 连不上而报错或空屏。
    const r = await evalJs(`(() => {
      const st = window.dawview.state;
      return {
        webuiGlobal: typeof window.webui,
        webuiScripts: document.querySelectorAll('script[src*=webui]').length,
        source: st.dataSource,
        tracks: st.view.tracks.length,
        status: document.getElementById('status-text').textContent,
        bodyOk: !!document.getElementById('tl').width,
      };
    })()`);
    return {
      pass: r.webuiGlobal === 'undefined' && r.webuiScripts === 0
            && r.source === 'file' && r.tracks > 0 && r.bodyOk
            && /project\.json/.test(r.status),
      detail: JSON.stringify(r),
    };
  }],
  ['多轨道可上下滚动（窄视口）', async () => {
    await send('Emulation.setDeviceMetricsOverride',
      { width: 1400, height: 300, deviceScaleFactor: 1, mobile: false });
    await sleep(600);
    const r = await evalJs(`(() => {
      const sc = document.getElementById('scroll');
      const spacer = document.getElementById('spacer');
      const c = document.getElementById('tl');
      const before = sc.scrollTop;
      sc.scrollTop = 90;
      sc.dispatchEvent(new Event('scroll'));
      const after = sc.scrollTop;
      // 画布由浏览器（合成器）钉在滚动口上：滚完立刻**同步**读 rect，位移必须 ≈ 0。
      // 旧写法是 absolute + JS translate，滚动事件异步 → 画布被拖走再弹回（用户报的"惯性弹动"）。
      const t0 = c.getBoundingClientRect().top;
      sc.scrollTop = after + 60;
      const moved = c.getBoundingClientRect().top - t0;
      sc.scrollTop = after;
      // 再验证轨道名栏钉在左侧：横向滚动后仍能读到名字（画布重画而非位移）
      sc.scrollLeft = 400;
      sc.dispatchEvent(new Event('scroll'));
      return { spacerH: parseInt(spacer.style.height), viewportH: sc.clientHeight,
               before, after, moved, pos: getComputedStyle(c).position,
               range: sc.scrollHeight - sc.clientHeight, scrollLeft: sc.scrollLeft };
    })()`);
    const pass = r.after > r.before              // 真的滚得动
      && r.range === r.spacerH                   // 滚动范围 = spacer 高度（画布本身只占一屏）
      && Math.abs(r.moved) < 1                   // 画布不被内容拖走
      && r.pos === 'sticky';
    return { pass, detail: JSON.stringify(r) };
  }],
  ['干净模式一键隐藏顶栏/轨道头/状态栏（H 恢复）', async () => {
    await send('Emulation.setDeviceMetricsOverride',
      { width: 1400, height: 600, deviceScaleFactor: 1, mobile: false });
    await sleep(400);
    const r = await evalJs(`(() => {
      const dv = window.dawview;
      const d = (sel) => getComputedStyle(document.querySelector(sel)).display;
      dv.setClean(true);
      const on = { clean: document.body.classList.contains('clean'),
                   bar: d('.bar'), status: d('.status'), headW: dv.state.view.headW };
      document.dispatchEvent(new KeyboardEvent('keydown', { code: 'KeyH' }));
      const off = { clean: document.body.classList.contains('clean'), bar: d('.bar'),
                    status: d('.status'), headW: dv.state.view.headW };
      return { on, off };
    })()`);
    return {
      pass: r.on.clean && r.on.bar === 'none' && r.on.status === 'none' && r.on.headW === 0
            && !r.off.clean && r.off.bar !== 'none' && r.off.status !== 'none' && r.off.headW > 0,
      detail: JSON.stringify(r),
    };
  }],
  ['片段名开关改变画布内容', async () => {
    const r = await evalJs(`(() => {
      const dv = window.dawview, sc = document.getElementById('scroll');
      sc.scrollLeft = 0; sc.scrollTop = 0; sc.dispatchEvent(new Event('scroll'));
      dv.paint();
      const c = document.getElementById('tl'), ctx = c.getContext('2d');
      const dpr = window.devicePixelRatio || 1;
      const clip = dv.state.project.tracks.find((t) => t.clips.length).clips[0];
      const x0 = Math.round(dv.state.view.headW + clip.startTick * dv.state.pxPerTick - dv.state.scrollX) + 2;
      const y0 = Math.round(30 + 4 - dv.state.scrollY);
      const sample = () => {
        const d = ctx.getImageData(x0 * dpr, y0 * dpr, 120 * dpr, 16 * dpr).data;
        let s = 0;
        for (let i = 0; i < d.length; i += 4) s += d[i] + d[i + 1] + d[i + 2];
        return s;
      };
      dv.setClipNames(true); dv.paint();
      const withNames = sample();
      dv.setClipNames(false); dv.paint();
      const without = sample();
      dv.setClipNames(true); dv.paint();
      const back = sample();
      return { withNames, without, back, x0, y0 };
    })()`);
    return {
      pass: r.withNames !== r.without && Math.abs(r.back - r.withNames) <= Math.max(60, r.withNames * 0.02),
      detail: JSON.stringify(r),
    };
  }],
  ['居中跟随把播放头钉在正中并连续滚动', async () => {
    const r = await evalJs(`(() => {
      const dv = window.dawview, sc = document.getElementById('scroll');
      dv.state.pxPerTick = 0.06;
      dv.rebuildView();
      dv.setFollowMode('center');
      // 选一个足够靠后的位置，否则 scrollLeft 会算成负数被夹到 0（开头几小节本就居中不了）
      dv.state.playheadTick = 20000;
      dv.followPlayhead();
      const headW = dv.state.view.headW;
      const screen = headW + dv.state.playheadTick * dv.state.pxPerTick - sc.scrollLeft;
      const want = headW + (sc.clientWidth - headW) / 2;
      const before = sc.scrollLeft;
      dv.state.playheadTick += 240;      // 走 240 tick
      dv.followPlayhead();
      const moved = sc.scrollLeft - before;
      dv.setFollowMode('page');
      return { screen, want, moved, headW, vw: sc.clientWidth, scrollLeft: sc.scrollLeft };
    })()`);
    return {
      pass: Math.abs(r.screen - r.want) < 2 && r.moved > 5,
      detail: JSON.stringify(r),
    };
  }],
  ['Ctrl+滚轮时间缩放且锚定指针位置', async () => {
    const r = await evalJs(`(() => {
      const dv = window.dawview, sc = document.getElementById('scroll');
      sc.scrollLeft = 0; sc.dispatchEvent(new Event('scroll'));
      const rect = sc.getBoundingClientRect();
      const px0 = dv.state.pxPerTick;
      const tickBefore = (700 + sc.scrollLeft - dv.state.view.headW) / dv.state.view.pxPerTick;
      sc.dispatchEvent(new WheelEvent('wheel', {
        deltaY: -100, ctrlKey: true, clientX: rect.left + 700, bubbles: true, cancelable: true }));
      const tickAfter = (700 + sc.scrollLeft - dv.state.view.headW) / dv.state.view.pxPerTick;
      // 像素取整允许 ~1px 误差，换算回 tick 再比
      const driftPx = Math.abs(tickAfter - tickBefore) * dv.state.pxPerTick;
      return { px0, px1: dv.state.pxPerTick, tickBefore, tickAfter, driftPx };
    })()`);
    return {
      pass: r.px1 > r.px0 * 1.05 && r.driftPx < 2,
      detail: JSON.stringify(r),
    };
  }],
  ['Alt+滚轮行高缩放', async () => {
    const r = await evalJs(`(() => {
      const dv = window.dawview, sc = document.getElementById('scroll');
      const rect = sc.getBoundingClientRect();
      const h0 = dv.state.view.rowH;
      const sp0 = parseInt(document.getElementById('spacer').style.height);
      const rg0 = sc.scrollHeight - sc.clientHeight;
      const wheel = (dy) => sc.dispatchEvent(new WheelEvent('wheel', {
        deltaY: dy, altKey: true, clientY: rect.top + 120, bubbles: true, cancelable: true }));
      wheel(-100);
      const h1 = dv.state.view.rowH;
      const sp1 = parseInt(document.getElementById('spacer').style.height);
      const rg1 = sc.scrollHeight - sc.clientHeight;
      wheel(100);                        // 缩回去，别影响后面的截图
      return { h0, h1, sp0, sp1, rg0, rg1, h2: dv.state.view.rowH };
    })()`);
    return {
      pass: r.h1 > r.h0 * 1.05 && r.rg1 >= r.rg0 && r.sp1 === r.rg1
            && Math.abs(r.h2 - r.h0) < 0.5,
      detail: JSON.stringify(r),
    };
  }],
  ['设置菜单是二级结构（分组 → 选项）', async () => {
    const r = await evalJs(`(() => {
      const dv = window.dawview;
      const menu = document.getElementById('settings-menu');
      document.getElementById('btn-settings').click();
      const opened = !menu.hidden;              // 必须当场读，后面会被关掉
      const groups = [...document.querySelectorAll('#menu-groups .grp')].map((b) => b.textContent);
      const firstPane = [...document.querySelectorAll('#menu-pane .pane.on .row-label')].map((b) => b.textContent);
      // 点「动效」分组 → 二级面板换成动效选项
      const fxBtn = [...document.querySelectorAll('#menu-groups .grp')].find((b) => b.textContent === '动效');
      fxBtn.click();
      const fxPane = [...document.querySelectorAll('#menu-pane .pane.on .row-label')].map((b) => b.textContent);
      const active = document.querySelector('#menu-groups .grp.on').textContent;
      // 「音频」分组：用户音频轨的入口（导入 / 加轨 / 吸附 / 播放 / 显示 / 存放位置）
      [...document.querySelectorAll('#menu-groups .grp')].find((b) => b.textContent === '音频').click();
      const audioPane = [...document.querySelectorAll('#menu-pane .pane.on .row-label')].map((b) => b.textContent);
      // 通过真实 UI 切到钢琴窗：点「视图」分组的「钢琴窗」按钮
      [...document.querySelectorAll('#menu-groups .grp')].find((b) => b.textContent === '视图').click();
      const seg = document.querySelector('#menu-pane .seg[data-item="opt-viewmode"][data-value="midi"]');
      seg.click();
      const modeAfterClick = dv.state.viewMode;
      dv.setViewMode('arrange');
      document.getElementById('btn-settings').click();
      const closed = menu.hidden;
      return { opened, groups, firstPane, fxPane, audioPane, active, modeAfterClick, closed };
    })()`);
    return {
      pass: r.opened && r.groups.join(',') === '显示,视图,播放,控制器,音频,动效,配色'
            && r.firstPane.length >= 3 && r.fxPane.includes('音符闪光') && r.active === '动效'
            && r.audioPane.includes('导入音频') && r.audioPane.includes('播放音频')
            && r.modeAfterClick === 'midi' && r.closed,
      detail: JSON.stringify(r),
    };
  }],
  ['钢琴窗视图只画 MIDI 音符', async () => {
    const r = await evalJs(`(() => {
      const dv = window.dawview, sc = document.getElementById('scroll');
      dv.setViewMode('midi');
      const c = document.getElementById('tl'), ctx = c.getContext('2d');
      const dpr = window.devicePixelRatio || 1;
      dv.paint();
      const v = dv.state.view;
      // 左侧键栏有内容（钢琴键），右侧音符区有音符像素
      const keys = ctx.getImageData(0, (30 + 40) * dpr, 60 * dpr, 200 * dpr).data;
      let keyLit = 0;
      for (let i = 0; i < keys.length; i += 4) if (keys[i] > 90) keyLit++;
      const area = ctx.getImageData((v.headW + 2) * dpr, 30 * dpr, 700 * dpr, (c.clientHeight - 40) * dpr).data;
      const colors = new Set();
      for (let i = 0; i < area.length; i += 4) colors.add(area[i] + ',' + area[i + 1] + ',' + area[i + 2]);
      const status = document.getElementById('status-text').textContent;
      const info = { mode: v.mode, notes: v.notes.length, headW: v.headW, keyLit,
                     colors: colors.size, status, scrollH: parseInt(document.getElementById('spacer').style.height) };
      dv.setViewMode('arrange');
      info.backTo = dv.state.view.mode;
      return info;
    })()`);
    return {
      pass: r.mode === 'midi' && r.notes === 191 && r.headW === 64 && r.keyLit > 50
            && r.colors > 4 && /钢琴窗/.test(r.status) && r.backTo === 'arrange',
      detail: JSON.stringify(r),
    };
  }],
  ['播放动效：命中记录 + 画布亮起 + 可关闭', async () => {
    const r = await evalJs(`(() => {
      const dv = window.dawview, sc = document.getElementById('scroll');
      dv.setViewMode('arrange');
      dv.state.pxPerTick = 0.08; dv.rebuildView();
      sc.scrollLeft = 0; sc.scrollTop = 0; sc.dispatchEvent(new Event('scroll'));
      const c = document.getElementById('tl'), ctx = c.getContext('2d');
      const dpr = window.devicePixelRatio || 1;
      const clip = dv.state.project.tracks.flatMap((t) => t.clips).find((x) => x.kind === 'midi');
      const from = clip.startTick + clip.notes[20].startTick - 30;
      const sum = () => {
        const d = ctx.getImageData(0, 0, c.width, c.height).data;
        let s = 0;
        for (let i = 0; i < d.length; i += 4) s += d[i] + d[i + 1] + d[i + 2];
        return s;
      };
      dv.setFx({ on: true, note: true });
      dv.state.hits = [];
      dv.state.playheadTick = from;
      dv.collectHits(from, from + 60);
      const hits = dv.state.hits.length;
      // MIDI 音符带里"像音符"的像素数：动效不能把后面的音符画没了
      const bandNotes = () => {
        const d = ctx.getImageData(200 * dpr, 36 * dpr, 1100 * dpr, 34 * dpr).data;
        let n = 0;
        for (let i = 0; i < d.length; i += 4) if (d[i] > 60 && d[i + 2] > 130) n++;
        return n;
      };
      dv.paint();
      const litWithFx = sum();
      const notesWith = bandNotes();
      dv.state.hits = [];
      dv.paint();
      const litNoFx = sum();
      const notesNo = bandNotes();
      // 关掉动效后不再产生命中
      dv.setFx({ on: false });
      dv.state.hits = [];
      dv.collectHits(from, from + 2000);
      const hitsWhenOff = dv.state.hits.length;
      dv.setFx({ on: true });
      return { hits, litWithFx, litNoFx, notesWith, notesNo, hitsWhenOff, from };
    })()`);
    return {
      pass: r.hits > 0 && r.litWithFx > r.litNoFx && r.hitsWhenOff === 0
            && r.notesWith >= r.notesNo,      // 有动效时音符不能反而变少（fillStyle 污染回归）
      detail: JSON.stringify(r),
    };
  }],
  ['钢琴窗显示全部 128 个琴键', async () => {
    const r = await evalJs(`(() => {
      const dv = window.dawview, sc = document.getElementById('scroll');
      dv.setViewMode('midi');
      const v = dv.state.view;
      const c = document.getElementById('tl'), ctx = c.getContext('2d');
      const keyBand = () => {
        const d = ctx.getImageData(0, 40, 60, 300).data;
        let n = 0;
        for (let i = 0; i < d.length; i += 4) if (d[i] > 60) n++;
        return n;
      };
      const noteBand = () => {
        const d = ctx.getImageData(v.headW + 2, 30, 700, c.clientHeight - 40).data;
        let n = 0;
        for (let i = 0; i < d.length; i += 4) if (d[i] > 60 && d[i + 2] > 120) n++;
        return n;
      };
      const info = {
        lo: v.pitchLo, hi: v.pitchHi, keys: v.pitchHi - v.pitchLo + 1,
        noteLo: v.noteLo, noteHi: v.noteHi, semiH: v.semiH,
        spacerH: parseInt(document.getElementById('spacer').style.height),
        clientH: sc.clientHeight,
        scrollTop: Math.round(sc.scrollTop),
        notesSeen: noteBand(),        // 进视图自动滚到音符音区 → 第一屏就看得到音符
      };
      sc.scrollTop = 99999; sc.dispatchEvent(new Event('scroll')); dv.paint();
      info.keyLitBottom = keyBand();  // 滚到最低音区，键栏照样有键
      sc.scrollTop = 0; sc.dispatchEvent(new Event('scroll')); dv.paint();
      info.keyLitTop = keyBand();     // 滚到最高音区同理
      dv.setViewMode('arrange');
      return info;
    })()`);
    return {
      pass: r.lo === 0 && r.hi === 127 && r.keys === 128
            && r.spacerH + r.clientH >= 128 * r.semiH && r.notesSeen > 0
            && r.keyLitTop > 50 && r.keyLitBottom > 50,
      detail: JSON.stringify(r),
    };
  }],
  ['钢琴窗音符滚出左边界被裁掉（不顶在键栏上）', async () => {
    const r = await evalJs(`(() => {
      const dv = window.dawview, sc = document.getElementById('scroll');
      dv.setViewMode('midi');
      dv.state.pxPerTick = 0.2; dv.rebuildView();
      const v = dv.state.view;
      let best = v.notes[0];
      for (const n of v.notes) if (n.lengthTick > best.lengthTick) best = n;
      // 滚到"这个音符的尾巴刚过键栏左边 4px"的位置
      const x1 = v.headW + (best.tick + best.lengthTick) * v.pxPerTick;
      sc.scrollLeft = Math.round(x1 - v.headW + 4);
      sc.scrollTop = Math.max(0, Math.round(30 + (v.pitchHi - best.pitch) * v.semiH - 200));
      sc.dispatchEvent(new Event('scroll'));
      dv.paint();
      const c = document.getElementById('tl'), ctx = c.getContext('2d');
      const ny = Math.round(30 + (v.pitchHi - best.pitch) * v.semiH - sc.scrollTop);
      // 该音符那一行、紧贴键栏右侧的一小条：旧写法会把长音符 clamp 到这里
      const d = ctx.getImageData(v.headW, ny, 8, Math.max(3, v.semiH)).data;
      let lit = 0;
      for (let i = 0; i < d.length; i += 4) if (d[i] > 70 && d[i + 2] > 130) lit++;
      // 顺带确认这个音符确实滚出去了（真实几何整个在键栏左侧）
      const trueLeft = v.headW + best.tick * v.pxPerTick - sc.scrollLeft;
      const trueRight = trueLeft + best.lengthTick * v.pxPerTick;
      dv.state.pxPerTick = 0.04; dv.rebuildView();
      dv.setViewMode('arrange');
      return { lit, noteLen: best.lengthTick, pitch: best.pitch, trueLeft: Math.round(trueLeft), trueRight: Math.round(trueRight), ny, headW: v.headW };
    })()`);
    return { pass: r.lit === 0 && r.trueRight <= r.headW, detail: JSON.stringify(r) };
  }],
  ['播放头动效只剩矩形拖尾（无圆形光晕）', async () => {
    const r = await evalJs(`(() => {
      const dv = window.dawview, sc = document.getElementById('scroll');
      dv.setViewMode('arrange');
      dv.state.pxPerTick = 0.08; dv.rebuildView();
      sc.scrollLeft = 0; sc.scrollTop = 0; sc.dispatchEvent(new Event('scroll'));
      dv.setFx({ on: true, head: true, strength: 1, decay: 420 });
      dv.state.hits = [];
      dv.state.playheadTick = 3000;      // 屏幕 x = 200 + 3000*0.08 = 440，拖尾完整可见
      dv.state.playing = false;
      dv.paint();
      const c = document.getElementById('tl'), ctx = c.getContext('2d');
      const before = ctx.getImageData(0, 0, c.width, c.height).data;
      const dpr = window.devicePixelRatio || 1;
      dv.state.playing = true;
      dv.paint();
      const after = ctx.getImageData(0, 0, c.width, c.height).data;
      dv.state.playing = false; dv.paint();
      const px = Math.round(dv.state.view.headW + dv.state.playheadTick * dv.state.pxPerTick - sc.scrollLeft);
      const headPx = Math.round(dv.state.view.headW * dpr);   // 拖尾被裁在内容区，只在内容区找左端
      let right = 0, left = 0, minX = 1e9;
      for (let i = 0; i < after.length; i += 4) {
        const d = (after[i] + after[i+1] + after[i+2]) - (before[i] + before[i+1] + before[i+2]);
        if (d > 3) {
          const x = (i / 4) % c.width;
          if (x > px + 1) right++; else { left++; if (x < minX && x >= headPx) minX = x; }
        }
      }
      return { px, right, left, trailPx: px - minX };
    })()`);
    return {
      pass: r.right <= 2 && r.left > 0 && r.trailPx >= 100 && r.trailPx <= 140,
      detail: JSON.stringify(r),
    };
  }],
  ['横向滚动后网格铺满视口（放大时也是）', async () => {
    const r = await evalJs(`(() => {
      const dv = window.dawview, sc = document.getElementById('scroll');
      dv.setViewMode('arrange');
      dv.state.pxPerTick = 0.5; dv.rebuildView();      // 放大到 0.5px/tick
      sc.scrollTop = 0; sc.scrollLeft = 820;           // 滚到"小节线正好落在右侧"的位置
      sc.dispatchEvent(new Event('scroll'));
      dv.paint();
      const c = document.getElementById('tl'), ctx = c.getContext('2d');
      const dpr = window.devicePixelRatio || 1;
      const h = c.height;
      const img = ctx.getImageData(0, Math.round(34 * dpr), c.width, h - Math.round(60 * dpr)).data;
      const W = c.width, rows = Math.floor(img.length / 4 / W);
      // 竖线特征：某一列与它左边 3px 差得多的行数（网格线≈整列都差，底色/片段≈0）
      const colScore = (x) => {
        let n = 0;
        for (let y = 0; y < rows; y++) {
          const i = (y * W + x) * 4, j = (y * W + x - 3) * 4;
          const d = Math.abs(img[i] - img[j]) + Math.abs(img[i+1] - img[j+1]) + Math.abs(img[i+2] - img[j+2]);
          if (d > 8) n++;
        }
        return n;
      };
      const best = (x0, x1) => {
        let m = 0, at = -1;
        for (let x = Math.max(4, x0); x < x1; x++) { const s = colScore(x); if (s > m) { m = s; at = x; } }
        return [m, at];
      };
      const headW = Math.round(dv.state.view.headW * dpr);
      const info = { headW, w: W, rows, scrollLeft: sc.scrollLeft };
      const L = best(headW + 5, Math.floor(W / 2));
      const R = best(W - 200, W - 2);
      info.leftLine = L[0]; info.leftAt = L[1];
      info.rightLine = R[0]; info.rightAt = R[1];   // 修复前这里≈0（右侧一条竖线都没有）
      dv.state.pxPerTick = 0.04; dv.rebuildView();
      sc.scrollLeft = 0; sc.dispatchEvent(new Event('scroll')); dv.paint();
      return info;
    })()`);
    return {
      pass: r.leftLine > r.rows * 0.6 && r.rightLine > r.rows * 0.6,
      detail: JSON.stringify(r),
    };
  }],
  ['轨道显示/隐藏选择器（走带与钢琴窗同时生效）', async () => {
    const r = await evalJs(`(() => {
      const dv = window.dawview, sc = document.getElementById('scroll');
      dv.setViewMode('arrange');
      dv.state.pxPerTick = 0.04; dv.rebuildView();
      sc.scrollLeft = 0; sc.scrollTop = 0; sc.dispatchEvent(new Event('scroll'));
      const out = {};
      dv.toggleTrackMenu(true);
      const menu = document.getElementById('track-menu');
      out.opened = !menu.hidden;
      out.rows = [...document.querySelectorAll('#track-menu .track-row .tn')].map((e) => e.textContent);
      out.count = document.getElementById('track-menu-count').textContent;
      // 走真实 UI 路径：点掉第 0 条（Pianoteq 8 01，带 MIDI）的勾
      const cb = document.querySelector('#track-menu input[data-track="0"]');
      cb.checked = false;
      cb.dispatchEvent(new Event('change'));
      out.tracksAfter = dv.state.view.tracks.length;
      out.status = document.getElementById('status-text').textContent;
      out.prefs = JSON.parse(localStorage.getItem('dawview.view') || '{}').hiddenTracks;
      dv.setViewMode('midi');
      out.pianoNotes = dv.state.view.notes.length;
      dv.setViewMode('arrange');
      const cb2 = document.querySelector('#track-menu input[data-track="0"]');
      cb2.checked = true;
      cb2.dispatchEvent(new Event('change'));
      out.tracksBack = dv.state.view.tracks.length;
      out.statusBack = document.getElementById('status-text').textContent;
      dv.toggleTrackMenu(false);
      out.closed = menu.hidden;
      return out;
    })()`);
    return {
      pass: r.opened && r.rows.length === 4 && r.count === '显示 4 / 4 条轨道'
            && r.tracksAfter === 3 && r.pianoNotes === 0 && JSON.stringify(r.prefs) === '[0]'
            && /隐藏 1/.test(r.status) && r.tracksBack === 4 && !/隐藏/.test(r.statusBack) && r.closed,
      detail: JSON.stringify(r),
    };
  }],

  ['播放头光效被裁在内容区（不盖轨道头 / 钢琴键栏）', async () => {
    await send('Emulation.setDeviceMetricsOverride',
      { width: 1400, height: 900, deviceScaleFactor: 1, mobile: false });
    await sleep(400);
    const r = await evalJs(`(() => {
      const dv = window.dawview, sc = document.getElementById('scroll');
      const c = document.getElementById('tl'), ctx = c.getContext('2d');
      const dpr = window.devicePixelRatio || 1;
      const grab = () => ctx.getImageData(0, 0, c.width, c.height).data;
      // 逐像素比两帧。判据用"整列变化像素数"（形状特征）而不是单像素色差：
      // 半透明填充的取整抖动会让色卡圆角几个像素差十几二十，
      // 而拖尾是一条贯穿整个画布高度的带子（每列 ~780 像素）。
      const diff = (a, b) => {
        const W = c.width, H = c.height;
        const headW = dv.state.view.headW;
        const px = Math.round(headW + dv.state.playheadTick * dv.state.pxPerTick);
        const rows = Math.round(30 * dpr);            // 标尺高 30 CSS px
        const colAll = new Array(W).fill(0);          // 每列变化的像素数（整高）
        const colHead = new Array(W).fill(0);         // 轨道头区（标尺以下）
        const colRuler = new Array(W).fill(0);        // 轨道头区的标尺格
        const changed = (i) =>
          Math.abs(b[i]-a[i]) + Math.abs(b[i+1]-a[i+1]) + Math.abs(b[i+2]-a[i+2]) > 3;
        for (let y = 0; y < H; y++) {
          const isRuler = y < rows;
          for (let x = 0; x < W; x++) {
            const i = (y * W + x) * 4;
            if (!changed(i)) continue;
            colAll[x]++;
            if (x / dpr < headW - 1) { if (isRuler) colRuler[x]++; else colHead[x]++; }
          }
        }
        let headMax = 0, rulerHeadSum = 0, contentMax = 0, strongLeft = null;
        for (let x = 0; x < W; x++) {
          const cx = x / dpr;
          if (cx < headW - 1) {
            headMax = Math.max(headMax, colHead[x]);
            rulerHeadSum += colRuler[x];
          } else if (cx < px - 1) {
            contentMax = Math.max(contentMax, colAll[x]);
            if (colAll[x] > 300 && strongLeft === null) strongLeft = Math.round(cx);
          }
        }
        return { headMax, rulerHeadSum, contentMax, strongLeft, headW, px, canvasH: H };
      };
      const out = {};
      dv.setViewMode('arrange');
      dv.state.pxPerTick = 0.08; dv.rebuildView();
      sc.scrollLeft = 0; sc.scrollTop = 0; sc.dispatchEvent(new Event('scroll'));
      dv.setFx({ on: true, head: true, strength: 1 });
      dv.state.hits = [];
      dv.state.playheadTick = 500;        // 屏幕 x = 240：拖尾往左 130px 会伸进轨道头
      dv.state.playing = false;
      dv.paint(); dv.paint();             // 预热两帧，避开首帧渲染抖动
      const b1 = grab();
      dv.state.playing = true; dv.paint();
      const w1 = grab();
      dv.state.playing = false; dv.paint();
      out.arrange = diff(b1, w1);
      // 钢琴窗的键栏同理
      dv.setViewMode('midi');
      dv.state.playheadTick = 250;        // 屏幕 x = 64 + 20
      dv.state.playing = false;
      dv.paint(); dv.paint();
      const b2 = grab();
      dv.state.playing = true; dv.paint();
      const w2 = grab();
      dv.state.playing = false; dv.paint();
      out.midi = diff(b2, w2);
      dv.setViewMode('arrange');
      dv.state.pxPerTick = 0.04; dv.rebuildView();
      dv.state.playheadTick = 0; dv.paint();
      return out;
    })()`);
    const a = r.arrange, m = r.midi;
    // 轨道头/键栏那一列最多只许有几像素的渲染抖动（实测 ≤ 44），
    // 拖尾压上去会是整列 ~780 像素 —— 阈值 300 把两者分得很开。
    return {
      pass: a.headMax < 300 && a.rulerHeadSum < 100 && a.contentMax > 300
            && (a.px - a.strongLeft) >= 30
            && m.headMax < 300 && m.rulerHeadSum < 100 && m.contentMax > 300,
      detail: JSON.stringify(r),
    };
  }],

  ['轨道色卡：每条轨道单独配色（真点色卡 → 选色 → 走带/钢琴窗都变）', async () => {
    await send('Emulation.setDeviceMetricsOverride',
      { width: 1400, height: 900, deviceScaleFactor: 1, mobile: false });
    await sleep(400);
    const RED = '#e2705f';

    // 每条轨道都有自己的色卡，且热区命中自己那条；配色固定成水蓝，断言不随上个用例的主题漂
    const perTrack = await evalJs(`(() => {
      const dv = window.dawview, sc = document.getElementById('scroll');
      const sel = document.getElementById('theme-select');
      sel.value = 'aqua'; sel.dispatchEvent(new Event('change'));
      dv.setViewMode('arrange');
      dv.state.hiddenTracks.clear();
      dv.state.pxPerTick = 0.04; dv.rebuildView();
      sc.scrollLeft = 0; sc.scrollTop = 0; sc.dispatchEvent(new Event('scroll'));
      dv.paint(); dv.paint();
      const v = dv.state.view;
      const hits = [];
      for (let i = 0; i < v.tracks.length; i++) {
        const s = trackSwatchRect(v, i);
        hits.push(s ? dv.swatchTrackAt(s.x + s.w / 2, s.y + s.h / 2) : null);
      }
      return { tracks: v.tracks.length, hits };
    })()`);

    // 音频片段（第 2 条轨道）开头那段的均值色：波形柱只画在片段前 120px，采样就取前 90px
    const bandMean = () => evalJs(`(() => {
      const dv = window.dawview, c = document.getElementById('tl'), ctx = c.getContext('2d');
      const dpr = window.devicePixelRatio || 1;
      const v = dv.state.view, t = v.tracks[1];
      const clip = (t.clips || []).find((x) => x.kind === 'audio') || t.clips[0];
      const x0 = Math.round(v.headW + clip.startTick * v.pxPerTick) + 2;
      const w = 90, h = Math.round(v.rowH - 12);
      const y0 = Math.round(30 + 1 * v.rowH + 5);
      const d = ctx.getImageData(x0 * dpr, y0 * dpr, Math.round(w * dpr), Math.round(h * dpr)).data;
      let r = 0, g = 0, b = 0, n = 0;
      for (let i = 0; i < d.length; i += 4) { r += d[i]; g += d[i + 1]; b += d[i + 2]; n++; }
      return { r: +(r / n).toFixed(1), g: +(g / n).toFixed(1), b: +(b / n).toFixed(1) };
    })()`);
    // 钢琴窗里"偏红"的像素数：默认音符是蓝的 → 0；轨道改成红色后应当成片出现
    const reddish = () => evalJs(`(() => {
      const c = document.getElementById('tl'), ctx = c.getContext('2d');
      const d = ctx.getImageData(0, 0, c.width, c.height).data;
      let n = 0;
      for (let i = 0; i < d.length; i += 4) {
        if (d[i] > 60 && d[i] > d[i + 2] + 20 && d[i] > d[i + 1] + 10) n++;
      }
      return n;
    })()`);
    const toView = (m) => evalJs(`(() => { window.dawview.setViewMode('${m}'); return true; })()`);

    await toView('midi');
    const midiRedBefore = await reddish();
    await toView('arrange');
    const bandBefore = await bandMean();
    const tickBefore = await evalJs(`window.dawview.state.playheadTick`);

    // ① 真点第 1 条轨道的色卡 → 选择器打开
    const c0 = await swatchCenter(0);
    await clickAt(c0.x, c0.y);
    const opened = await evalJs(`(() => {
      const p = document.getElementById('swatch-pop');
      return { open: !p.hidden, track: window.dawview.state.swatchTrack,
               title: document.getElementById('swatch-name').textContent,
               buttons: document.querySelectorAll('#swatch-grid button').length,
               tick: window.dawview.state.playheadTick };
    })()`);

    // ② 真点调色板里的红色
    const btn0 = await evalJs(`(() => {
      const r = document.querySelector('#swatch-grid button[data-hex="${RED}"]').getBoundingClientRect();
      return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
    })()`);
    await clickAt(btn0.x, btn0.y);
    const applied = await evalJs(`(() => {
      const dv = window.dawview;
      return { colors: { ...dv.state.trackColors },
               stored: JSON.parse(localStorage.getItem('dawview.trackColors') || '{}'),
               popOpen: !document.getElementById('swatch-pop').hidden };
    })()`);
    const redPixel = await swatchPixel(0);
    await toView('midi');
    const midiRedAfter = await reddish();
    await toView('arrange');

    // ③ 第 2 条轨道的色卡（选择器跟着切到它），改成红色 → 音频片段整块偏红
    const c1 = await swatchCenter(1);
    await clickAt(c1.x, c1.y);
    const switched = await evalJs(`window.dawview.state.swatchTrack`);
    const btn1 = await evalJs(`(() => {
      const r = document.querySelector('#swatch-grid button[data-hex="${RED}"]').getBoundingClientRect();
      return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
    })()`);
    await clickAt(btn1.x, btn1.y);
    const bandAfter = await bandMean();

    // ④ 轨道选择器里的小色点跟着变
    const dot = await evalJs(`(() => {
      const dv = window.dawview;
      dv.toggleTrackMenu(true);
      const el = document.querySelector('#track-menu .sw[data-sw="1"]');
      const bg = el ? getComputedStyle(el).backgroundColor : null;
      dv.toggleTrackMenu(false);
      return bg;
    })()`);

    // ⑤ 自定义取色（原生取色器 input 事件）
    const custom = await evalJs(`(() => {
      const dv = window.dawview;
      const inp = document.getElementById('swatch-custom');
      inp.value = '#5fa87a';
      inp.dispatchEvent(new Event('input', { bubbles: true }));
      return { colors: { ...dv.state.trackColors },
               stored: JSON.parse(localStorage.getItem('dawview.trackColors') || '{}') };
    })()`);

    // ⑥ 选择器里的「默认」按钮 → 这条轨道回到默认色
    const resetBtn = await evalJs(`(() => {
      const r = document.getElementById('swatch-reset').getBoundingClientRect();
      return { x: r.left + r.width / 2, y: r.top + r.height / 2,
               open: !document.getElementById('swatch-pop').hidden };
    })()`);
    await clickAt(resetBtn.x, resetBtn.y);
    // ⑦ 右键色卡也能恢复默认（这时只剩第 1 条轨道还是红的）
    const c0b = await swatchCenter(0);
    await rightClickAt(c0b.x, c0b.y);
    const afterReset = await evalJs(`(() => ({
      colors: { ...window.dawview.state.trackColors },
      stored: JSON.parse(localStorage.getItem('dawview.trackColors') || '{}'),
    }))()`);
    const defaultPixel = await swatchPixel(0);
    await toView('midi');
    const midiRedReset = await reddish();
    await toView('arrange');

    // ⑧ Esc 关掉选择器（真按键）
    const c2 = await swatchCenter(0);
    await keyPress('Escape', 'Escape', 27);          // 先确保是关着的（Esc 关不掉别的什么）
    const closedBefore = await evalJs(`document.getElementById('swatch-pop').hidden`);
    await clickAt(c2.x, c2.y);
    const openedAgain = await evalJs(`!document.getElementById('swatch-pop').hidden`);
    await keyPress('Escape', 'Escape', 27);
    const closedByEsc = await evalJs(`document.getElementById('swatch-pop').hidden`);

    const sameRed = redPixel[0] === 226 && redPixel[1] === 112 && redPixel[2] === 95;
    return {
      pass: perTrack.tracks === 4 && perTrack.hits.join(',') === '0,1,2,3'
            && midiRedBefore <= 20
            && opened.open && opened.track === 0 && /Pianoteq/.test(opened.title)
            && opened.buttons === 12 && opened.tick === tickBefore          // 点色卡不动播放头
            && applied.colors['0'] === RED && applied.stored['26.9.6 lulabi']['0'] === RED
            && applied.popOpen && sameRed
            && midiRedAfter > 200
            && switched === 1
            && bandAfter.r > bandBefore.r + 8 && bandAfter.g < bandBefore.g - 8
            && /^rgb\(226, 112, 95\)$/.test(dot || '')
            && custom.colors['1'] === '#5fa87a' && custom.stored['26.9.6 lulabi']['1'] === '#5fa87a'
            && Object.keys(afterReset.colors).length === 0
            && !afterReset.stored['26.9.6 lulabi']
            && defaultPixel[2] > defaultPixel[0]                          // 回到水蓝默认色
            && midiRedReset <= 20
            && closedBefore && openedAgain && closedByEsc,
      detail: JSON.stringify({ perTrack, midiRedBefore, bandBefore, opened, applied, redPixel,
                               midiRedAfter, switched, bandAfter, dot, custom, resetBtn,
                               afterReset, defaultPixel, midiRedReset,
                               closedBefore, openedAgain, closedByEsc }),
    };
  }],

  /* ---- 契约 v0.3：钢琴窗下部的力度 / CC 栏（默认不显示） ---- */

  ['控制器栏默认不显示：lanes 空 -> 不占高度', async () => {
    const r = await evalJs(`(() => {
      const dv = window.dawview;
      dv.setViewMode('midi');
      dv.state.lanes = [];
      dv.rebuildView();
      const h = document.getElementById('tl').clientHeight;
      const lay = dv.laneLayout(dv.state.view, h);
      return { total: lay.total, boxes: lay.boxes.length, top: lay.top, h,
               lanes: dv.state.view.lanes.length };
    })()`);
    return { pass: r.total === 0 && r.boxes === 0 && r.lanes === 0 && r.top === r.h,
             detail: JSON.stringify(r) };
  }],

  ['CC 栏的可选项来自契约 controllers', async () => {
    const r = await evalJs(`(() => {
      const dv = window.dawview;
      const ch = dv.ccChoices();
      return { choices: ch.map((c) => c.cc), names: ch.map((c) => c.name),
               points: ch.map((c) => c.n),
               raw: (dv.state.project.tracks || [])
                 .flatMap((t) => t.clips.flatMap((c) => c.controllers || [])).length };
    })()`);
    if (!r.raw) return { pass: true, detail: '这个工程没有 CC 数据（跳过）' };
    return { pass: r.choices.length > 0 && r.points.every((n) => n > 0)
                   && r.names.every((n) => !!n),
             detail: JSON.stringify(r) };
  }],

  ['加一栏力度 + 一栏 CC：音符区让出高度，两栏里都真画了东西', async () => {
    // 栏里的数据是主色画的 —— 按主色做像素分类，数得出来才算真画了
    const acc = String(await evalJs(
      `getComputedStyle(document.documentElement).getPropertyValue('--accent').trim()`) || '#3389d1')
      .replace('#', '');
    const ACC = [0, 2, 4].map((i) => parseInt(acc.slice(i, i + 2), 16));
    const r = await evalJs(`(() => {
      const dv = window.dawview;
      const c = document.getElementById('tl');
      const g = c.getContext('2d');
      const dpr = window.devicePixelRatio || 1;
      const h = c.clientHeight;
      const ACC = [${ACC.join(',')}];
      const countAccent = (y, hh) => {
        const x0 = Math.round(dv.state.view.headW * dpr);
        const d = g.getImageData(x0, Math.round(y * dpr),
                                 Math.max(1, c.width - x0), Math.round(hh * dpr)).data;
        let n = 0;
        for (let i = 0; i < d.length; i += 4) {
          if (Math.abs(d[i] - ACC[0]) < 32 && Math.abs(d[i + 1] - ACC[1]) < 32
              && Math.abs(d[i + 2] - ACC[2]) < 32) n++;
        }
        return n;
      };
      dv.setViewMode('midi');
      dv.state.lanes = [];
      dv.rebuildView();
      dv.paint();
      const none = dv.laneLayout(dv.state.view, h).total;
      const cc = (dv.ccChoices()[0] || {}).cc;
      dv.setVelocityLane(true);
      if (cc !== undefined) dv.addLane({ kind: 'cc', cc });
      dv.paint();
      const lay = dv.laneLayout(dv.state.view, h);
      const vel = lay.boxes.find((b) => b.lane.kind === 'velocity');
      const ccb = lay.boxes.find((b) => b.lane.kind === 'cc');
      return { none, total: lay.total, top: lay.top, h, cc,
               lanes: dv.state.view.lanes.length,
               velAccent: countAccent(vel.y + 18, vel.h),
               ccAccent: ccb ? countAccent(ccb.y + 18, ccb.h) : 0,
               boxes: lay.boxes.map((b) => [b.lane.kind, b.lane.cc, Math.round(b.y), b.h]) };
    })()`);
    return { pass: r.none === 0 && r.total > 0 && r.top < r.h && r.lanes === 2
                   && r.velAccent > 150 && r.ccAccent > 150,
             detail: JSON.stringify(r) };
  }],

  ['栏位偏好只进 localStorage，不进数据契约', async () => {
    const r = await evalJs(`(() => {
      const dv = window.dawview;
      const saved = JSON.parse(localStorage.getItem('dawview.view') || '{}');
      return { lanes: saved.lanes, laneH: saved.laneH,
               inContract: Object.prototype.hasOwnProperty.call(dv.state.project, 'lanes'),
               jsonHasLanes: JSON.stringify(dv.state.project).includes('"lanes"') };
    })()`);
    return { pass: Array.isArray(r.lanes) && r.lanes.length === 2 && r.laneH > 0
                   && !r.inContract && !r.jsonHasLanes,
             detail: JSON.stringify(r) };
  }],

  ['设置菜单「控制器」组：力度栏勾选 + CC 编辑器 + 栏高', async () => {
    const r = await evalJs(`(() => {
      const grp = [...document.querySelectorAll('#menu-groups .grp')]
        .find((b) => b.textContent === '控制器');
      if (!grp) return { err: '没有控制器分组' };
      grp.click();
      const rows = [...document.querySelectorAll('#menu-pane .pane.on .row-label')].map((e) => e.textContent);
      const box = document.querySelector('#menu-pane .pane.on input[type=checkbox]');
      return { rows, sels: document.querySelectorAll('#menu-pane .lane-cc').length,
               del: document.querySelectorAll('#menu-pane .lane-del').length,
               add: !!document.querySelector('#menu-pane .lane-add'),
               checked: box ? box.checked : null,
               opts: [...document.querySelectorAll('#menu-pane .lane-cc option')].map((o) => o.textContent) };
    })()`);
    return { pass: !r.err && r.rows.includes('力度栏') && r.rows.includes('CC 曲线栏')
                   && r.rows.includes('单栏高度') && r.sels === 1 && r.del === 1
                   && r.add && r.checked === true,
             detail: JSON.stringify(r) };
  }],

  ['定速工程：速度轨单点，ticksPerSecond 就是 meta.bpm', async () => {
    const r = await evalJs(`(() => {
      const dv = window.dawview;
      const meta = dv.state.project.meta;
      dv.state.playheadTick = 0;
      return { points: dv.state.tempo.points, bpm: dv.state.tempo.bpmAt(10 ** 6),
               want: (meta.bpm / 60) * meta.ppq, got: dv.ticksPerSecond(),
               sec: dv.state.tempo.secAt(meta.ppq * 4) };
    })()`);
    return { pass: r.points === 1 && Math.abs(r.got - r.want) < 1e-6
                   && Math.abs(r.sec - 4 * 60 / r.bpm) < 1e-6,
             detail: JSON.stringify(r) };
  }],

  ['清掉控制器栏（回到默认不显示）', async () => {
    const r = await evalJs(`(() => {
      const dv = window.dawview;
      dv.state.lanes.slice().forEach((l) => dv.removeLane(l.id));
      const h = document.getElementById('tl').clientHeight;
      return { lanes: dv.state.lanes.length, total: dv.laneLayout(dv.state.view, h).total,
               saved: JSON.parse(localStorage.getItem('dawview.view') || '{}').lanes };
    })()`);
    return { pass: r.lanes === 0 && r.total === 0 && Array.isArray(r.saved) && r.saved.length === 0,
             detail: JSON.stringify(r) };
  }],
];

try {
  step('navigate');
  await send('Page.enable');            // addScriptToEvaluateOnNewDocument 需要 Page 域
  await send('Emulation.setDeviceMetricsOverride',
    { width: 1400, height: 900, deviceScaleFactor: 1, mobile: false });
  await send('Page.navigate', { url: TARGET });
  await sleep(1500);
  // 清掉上轮遗留的主题 / 显示选项 / 轨道颜色，重载后从确定状态开始
  await evalJs(`localStorage.removeItem('dawview.theme'); localStorage.removeItem('dawview.view'); localStorage.removeItem('dawview.trackColors')`);
  await evalJs(`location.reload()`);
  await sleep(2000);

  let failed = 0;
  // 数据快照不入库（带真实工程名/轨道名）。没有快照就整段跳过，
  // 不要对着别人的 web/project.json 跑断言（那会满屏 FAIL 且毫无意义）。
  if (!existsSync(fixture)) {
    console.log('• 没有 scripts/fixture-project.json —— 跳过 Cubase 那一段');
    console.log('  自己生成：python scripts/make-fixture.py "你的工程.cpr"');
  }
  for (const [name, fn] of (existsSync(fixture) ? checks : [])) {
    step(name);
    try {
      const r = await fn();
      console.log(`  ${r.pass ? 'PASS' : 'FAIL'} ${r.detail ?? ''}`);
      if (!r.pass) failed++;
    } catch (err) {
      console.log(`  ERROR ${err.message}`);
      failed++;
    }
  }

  step('screenshots');
  // 前面的用例把主题改成了 forest，截图前恢复默认水蓝，产物才稳定
  await evalJs(`(() => {
    const s = document.getElementById('theme-select');
    s.value = 'aqua';
    s.dispatchEvent(new Event('change'));
  })()`);
  await evalJs(`document.getElementById('scroll').scrollTop = 0`);
  await evalJs(`document.getElementById('scroll').scrollLeft = 0`);
  await evalJs(`document.getElementById('btn-fit').click()`);
  await sleep(400);
  await shot('shot-fit.png');
  await evalJs(`document.getElementById('scroll').scrollLeft = 0`);
  await evalJs(`window.dawview.state.pxPerTick = 0.12; document.getElementById('btn-zoom-in').click();`);
  await sleep(400);
  await shot('shot-zoom.png');

  // 干净模式（隐藏顶栏/轨道头/状态栏 + 片段名），录制走带用
  await evalJs(`window.dawview.setClipNames(false); window.dawview.setClean(true);`);
  await evalJs(`document.getElementById('scroll').scrollLeft = 0; document.getElementById('scroll').scrollTop = 0;`);
  await sleep(3000);        // 等提示气泡淡出，截到真正的录制画面
  await shot('shot-clean.png');
  await evalJs(`window.dawview.setClean(false); window.dawview.setClipNames(true);`);

  // 轨道选择器截图
  await evalJs(`window.dawview.toggleTrackMenu(true)`);
  await sleep(300);
  await shot('shot-tracks.png');
  await evalJs(`window.dawview.toggleTrackMenu(false)`);

  // 钢琴窗截图
  await evalJs(`window.dawview.setViewMode('midi'); document.getElementById('btn-fit').click();`);
  await sleep(600);
  await shot('shot-midi.png');

  // 动效截图：手动摆到"刚跨过音频片段入点"的那一帧（时间驱动抓不稳），
  // 命中记录是新的，光效最亮，画面稳定可复现
  await evalJs(`(() => {
    const dv = window.dawview;
    dv.setViewMode('arrange');
    dv.state.pxPerTick = 0.09; dv.rebuildView();
    dv.setFollowMode('center');
    dv.setFx({ strength: 1.4, decay: 700 });
    document.getElementById('scroll').scrollTop = 0;
    dv.state.playing = true;              // 只用来让播放头光效生效，不启动 rAF
    dv.state.hits = [];
    dv.collectHits(15540, 15640);         // 跨过 15600（音频片段入点）和 15607（音符）
    dv.state.playheadTick = 15640;
    dv.followPlayhead();
    dv.paint();
  })()`);
  await sleep(200);
  await shot('shot-fx.png');
  await evalJs(`(() => {
    const dv = window.dawview;
    dv.state.playing = false;
    dv.state.hits = [];
    dv.setFx({ strength: 1, decay: 420 });
  })()`);
  await evalJs(`(() => {
    const dv = window.dawview;
    dv.setPlaying(false);
    dv.setFollowMode('page');
    dv.setViewMode('arrange');
    dv.state.playheadTick = 0;
    document.getElementById('scroll').scrollLeft = 0;
    dv.paint();
  })()`);

  // ==================== FL Studio（.flp）快照 ====================
  // 后端换了宿主解析器，前端只认契约 —— 这一段验证"契约里新增的 automation /
  // other 片段与轨道种类，前端真的按新语义画"（不是把 FL 的自动化片段当 MIDI）。
  let flRan = 0;
  if (existsSync(flFixture)) {
    step('FL 工程快照（万古城.flp → fixture-project-fl.json）');
    copyFileSync(flFixture, live);
    await evalJs(`location.reload()`);
    await sleep(2500);

    const hex2rgb = (h) => {
      const s = String(h).trim().replace('#', '');
      return [parseInt(s.slice(0, 2), 16), parseInt(s.slice(2, 4), 16), parseInt(s.slice(4, 6), 16)];
    };
    const mean = (rows) => [0, 1, 2].map((i) => Math.round(rows.reduce((a, p) => a + p[i], 0) / rows.length));
    const dist = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);
    // 行内色散：假波形是每 3px 一根的竖条（同一行里有亮有暗），平涂则整行同色
    const spread = (rows) => {
      const mn = [255, 255, 255], mx = [0, 0, 0];
      for (const p of rows) for (let i = 0; i < 3; i++) { mn[i] = Math.min(mn[i], p[i]); mx[i] = Math.max(mx[i], p[i]); }
      return Math.max(mx[0] - mn[0], mx[1] - mn[1], mx[2] - mn[2]);
    };
    const themeColors = () => evalJs(`(() => {
      const cs = getComputedStyle(document.documentElement);
      const g = (n) => cs.getPropertyValue(n).trim();
      return { bg: g('--bg'), accent: g('--accent'), midi: g('--clip-midi'),
               audio: g('--clip-audio'), auto: g('--clip-auto') };
    })()`);
    // 找到某类片段 → 滚到它 → 采它"中线上"的一行像素。
    // 默认取片段宽度的 20%~80%（避开描边）；abs 给绝对像素窗口（假波形只画在
    // 片段开头 120px 左右，验音频时要采到那儿）。
    const clipRow = async (kind, abs) => {
      const info = await evalJs(`(() => {
        const dv = window.dawview;
        dv.setViewMode('arrange');
        dv.state.pxPerTick = 0.12;
        dv.rebuildView();
        const v = dv.state.view;
        for (let i = 0; i < v.tracks.length; i++) {
          for (const c of v.tracks[i].clips) {
            if (c.kind !== '${kind}') continue;
            const x0 = tickToX(v, c.startTick), x1 = tickToX(v, c.startTick + c.lengthTick);
            document.getElementById('scroll').scrollLeft = Math.max(0, x0 - 60);
            dv.paint();
            const sx = dv.state.scrollX;
            return { name: c.name, x0: x0 - sx, x1: x1 - sx, y: rowTop(v, i) + v.rowH / 2,
                     ti: i, pi: v.tracks[i].projectIndex, kind: c.kind };
          }
        }
        return null;
      })()`);
      if (!info) return null;
      const w = info.x1 - info.x0;
      const x0 = abs ? info.x0 + abs[0] : info.x0 + w * 0.2;
      const x1 = abs ? Math.min(info.x1, info.x0 + abs[1]) : info.x1 - w * 0.2;
      const n = Math.min(160, Math.max(8, Math.round(x1 - x0)));
      const px = await evalJs(`(() => {
        const c = document.getElementById('tl'), ctx = c.getContext('2d');
        const dpr = window.devicePixelRatio || 1;
        const y = Math.round(${info.y} * dpr);
        const out = [];
        for (let i = 0; i < ${n}; i++) {
          const x = Math.round((${x0} + (${x1} - ${x0}) * i / ${n - 1}) * dpr);
          const d = ctx.getImageData(x, y, 1, 1).data;
          out.push([d[0], d[1], d[2]]);
        }
        return out;
      })()`);
      return { ...info, px, w: info.x1 - info.x0 };
    };

    const flChecks = [
      ['FL 元信息（宿主 / 速度 / 采样率）', async () => {
        const t = await evalJs(`document.getElementById('proj-info').textContent`);
        return { pass: /万古城/.test(t) && /\bfl\b/.test(t) && /173 BPM/.test(t)
                      && /4\/4/.test(t) && /44100/.test(t), detail: t };
      }],

      ['FL 轨道/片段种类齐全', async () => {
        const d = await evalJs(`(() => {
          const s = window.dawview.state.project, tk = {}, ck = {};
          for (const t of s.tracks) {
            tk[t.kind] = (tk[t.kind] || 0) + 1;
            for (const c of t.clips) ck[c.kind] = (ck[c.kind] || 0) + 1;
          }
          return { tracks: s.tracks.length, clips: Object.values(ck).reduce((a, b) => a + b, 0), tk, ck };
        })()`);
        return {
          pass: d.tracks === 12 && d.clips === 26
                && d.tk.midi === 3 && d.tk.audio === 3 && d.tk.automation === 3 && d.tk.other === 3
                && d.ck.midi === 18 && d.ck.audio === 5 && d.ck.automation === 3,
          detail: JSON.stringify(d),
        };
      }],

      ['自动化片段：自动化色平涂（不再画假波形）', async () => {
        const c = await themeColors();
        const r = await clipRow('automation');
        if (!r) return { pass: false, detail: '没找到自动化片段' };
        const m = mean(r.px), sp = spread(r.px);
        // 片段底色是 0.16 透明度压在行底色上，只能和"混出来的颜色"比：
        // 拿原色比会得出反的结论（原色亮、混完暗，暗色反而离亮色更近）
        const blend = (hex) => [0, 1, 2].map((i) => Math.round(hex2rgb(c.bg)[i] * 0.84 + hex2rgb(hex)[i] * 0.16));
        const dAuto = dist(m, blend(c.auto));
        const dMidi = dist(m, blend(c.midi));
        const dAudio = dist(m, blend(c.audio));
        return {
          pass: dAuto < 12 && dAuto * 2 < dMidi && dAuto * 2 < dAudio && sp <= 30,
          detail: JSON.stringify({ name: r.name, w: Math.round(r.w), mean: m, spread: sp,
                                   dAuto: +dAuto.toFixed(1), dMidi: +dMidi.toFixed(1),
                                   dAudio: +dAudio.toFixed(1) }),
        };
      }],

      ['音频片段：波形还在（别把音频也改平了）', async () => {
        const r = await clipRow('audio', [6, 116]);   // 假波形只画在片段开头那 120px
        if (!r) return { pass: false, detail: '没找到音频片段' };
        return { pass: spread(r.px) > 40,
                 detail: JSON.stringify({ name: r.name, w: Math.round(r.w), spread: spread(r.px) }) };
      }],

      ['轨道种类标签显示中文「自动化」', async () => {
        await evalJs(`window.dawview.renderTrackMenu()`);
        const txt = await evalJs(`document.getElementById('track-menu-list').textContent`);
        return { pass: /自动化/.test(txt) && !/automation/.test(txt), detail: txt.slice(0, 100) };
      }],

      ['FL 的 ppq=96 走带标尺正确（768 tick = 第 3 小节）', async () => {
        const label = await evalJs(`(() => {
          const dv = window.dawview;
          dv.state.playheadTick = 768;
          dv.updatePosLabel();
          return document.getElementById('pos-label').textContent;
        })()`);
        // 标签现在带当前速度读数（v0.3 变速播放）：「3.1.0 · 173.0 BPM」
        return { pass: /^3\.1\.0 · [\d.]+ BPM$/.test(label.trim()), detail: label };
      }],

      /* ---- 滚动相关的两个绘制修复（12 条轨道 + 矮视口才滚得动） ---- */

      ['色卡按钮跟着轨道滚动，不钉在视口里', async () => {
        await send('Emulation.setDeviceMetricsOverride',
          { width: 1400, height: 320, deviceScaleFactor: 1, mobile: false });
        await sleep(400);
        const MAGENTA = '#ff00ff';
        const info = await evalJs(`(() => {
          const dv = window.dawview, sc = document.getElementById('scroll');
          dv.setViewMode('arrange');
          dv.state.hiddenTracks.clear();
          dv.state.kindFilter = '';
          dv.state.trackColors = {};
          dv.state.pxPerTick = 0.06;
          dv.rebuildView();
          sc.scrollLeft = 0;
          sc.scrollTop = 60;
          sc.dispatchEvent(new Event('scroll'));
          const v = dv.state.view, sy = dv.state.scrollY;
          // 只给一条"滚动后仍完整落在标尺以下"的轨道上独一无二的颜色
          let ti = -1;
          for (let i = 0; i < v.tracks.length; i++) {
            const y = rowTop(v, i) - sy;
            if (y >= 30 && y + v.rowH <= 320) { ti = i; break; }
          }
          dv.setTrackColor(v.tracks[ti].projectIndex, '${MAGENTA}');
          dv.paint(); dv.paint();
          const s = trackSwatchRect(v, ti, sy);
          // 期望位置按"规格"算，不从 trackSwatchRect 的 y 反推（否则实现错了检查也跟着错）：
          // 色卡应该待在行的垂直中间，并且跟着行一起滚
          const rowY = rowTop(v, ti) - sy;
          const off = (v.rowH - s.h) / 2;          // 行内偏移（居中）
          return { ti, sy, px: s.x + s.w / 2, h: s.h, rowY, rowH: v.rowH,
                   yExpect: rowY + off + s.h / 2,                        // 跟着行滚 → 应该在的位置
                   yWrong: rowTop(v, ti) + off + s.h / 2 };              // 旧写法：钉在视口里
        })()`);
        // 沿色卡那一列找洋红band（整列扫，不猜位置）
        const scan = await evalJs(`(() => {
          const c = document.getElementById('tl'), ctx = c.getContext('2d');
          const dpr = window.devicePixelRatio || 1;
          const x = Math.round(${info.px} * dpr);
          const bands = []; let run = null;
          for (let y = 0; y < c.height; y++) {
            const d = ctx.getImageData(x, y, 1, 1).data;
            const hit = d[0] > 170 && d[2] > 170 && d[1] < 130;
            if (hit) { if (!run) run = { y0: y / dpr }; run.y1 = y / dpr; }
            else if (run) { bands.push(run); run = null; }
          }
          if (run) bands.push(run);
          return bands;
        })()`);
        const center = scan.length === 1 ? (scan[0].y0 + scan[0].y1 + 1) / 2 : null;
        return {
          pass: center !== null && Math.abs(center - info.yExpect) <= 3
                && scan[0].y1 - scan[0].y0 >= info.h - 4,
          detail: JSON.stringify({ ...info, bands: scan, center }),
        };
      }],

      ['纵向滚动后轨道不穿透上方标尺', async () => {
        await send('Emulation.setDeviceMetricsOverride',
          { width: 1400, height: 320, deviceScaleFactor: 1, mobile: false });
        await sleep(400);
        // 标尺那一带（y 1..29）在"干净"和"压线滚动"两种状态下的像素必须一致：
        // 旧写法片段/轨道头只按"整行滚出"跳过，压线那一行会直接画进标尺里
        const band = () => evalJs(`(() => {
          const c = document.getElementById('tl'), ctx = c.getContext('2d');
          const dpr = window.devicePixelRatio || 1;
          const v = window.dawview.state.view;
          const out = [];
          for (let y = 1; y <= 29; y += 2) {
            for (let x = Math.round(v.headW) + 4; x < 1300; x += 3) {
              const d = ctx.getImageData(Math.round(x * dpr), Math.round(y * dpr), 1, 1).data;
              out.push(d[0], d[1], d[2]);
            }
          }
          return out;
        })()`);
        const setup = await evalJs(`(() => {
          const dv = window.dawview, sc = document.getElementById('scroll');
          dv.setViewMode('arrange');
          dv.state.trackColors = {};
          dv.state.pxPerTick = 0.12;
          dv.rebuildView();
          sc.scrollLeft = 0;
          sc.scrollTop = 0;
          sc.dispatchEvent(new Event('scroll'));
          dv.paint(); dv.paint();
          const v = dv.state.view;
          let ti = -1;
          for (let i = 0; i < v.tracks.length; i++) {
            if ((v.tracks[i].clips || []).length) { ti = i; break; }
          }
          return { ti, rowTop: rowTop(v, ti), rowH: v.rowH };
        })()`);
        const clean = await band();
        const at = await evalJs(`(() => {
          const dv = window.dawview, sc = document.getElementById('scroll');
          // 把有片段的那条轨道滚到"行顶压进标尺 12px"的位置
          sc.scrollTop = Math.max(0, ${setup.rowTop} - 12);
          sc.dispatchEvent(new Event('scroll'));
          dv.paint(); dv.paint();
          const v = dv.state.view;
          return { sy: dv.state.scrollY, rowY: rowTop(v, ${setup.ti}) - dv.state.scrollY };
        })()`);
        const bleeding = await band();
        let diff = 0;
        for (let i = 0; i < clean.length; i++) if (Math.abs(clean[i] - bleeding[i]) > 3) diff++;
        return {
          pass: at.rowY > 0 && at.rowY < 28 && diff === 0,
          detail: JSON.stringify({ rowY: at.rowY, sy: at.sy, sampled: clean.length / 3, diffPixels: diff }),
        };
      }],

      /* ---- 轨道选择器：按种类快速筛选 + 渐变上色 ---- */

      ['轨道选择器：按种类快速筛选（真点胶囊）', async () => {
        await send('Emulation.setDeviceMetricsOverride',
          { width: 1400, height: 900, deviceScaleFactor: 1, mobile: false });
        await sleep(400);
        await evalJs(`(() => {
          const dv = window.dawview, sc = document.getElementById('scroll');
          sc.scrollTop = 0; sc.scrollLeft = 0; sc.dispatchEvent(new Event('scroll'));
          dv.state.hiddenTracks.clear(); dv.state.kindFilter = '';
          dv.applyTrackFilter();
          dv.toggleTrackMenu(true);
        })()`);
        const chips = await evalJs(`[...document.querySelectorAll('#track-menu-filter .kind-chip')]
          .map((b) => ({ k: b.dataset.kind, t: b.textContent }))`);
        const counts = await evalJs(`window.dawview.trackKindCounts()`);
        const want = { '': 12, midi: 3, audio: 3, automation: 3, other: 3 };
        const chipsOk = chips.length === 5 && chips.every((c) => want[c.k] !== undefined);
        // 点"自动化"（真鼠标）
        const pos = await evalJs(`(() => {
          const b = [...document.querySelectorAll('#track-menu-filter .kind-chip')]
            .find((x) => x.dataset.kind === 'automation');
          const r = b.getBoundingClientRect();
          return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
        })()`);
        await clickAt(pos.x, pos.y);
        await sleep(400);
        const st = await evalJs(`(() => {
          const dv = window.dawview, s = dv.state;
          return { filter: s.kindFilter, viewTracks: s.view.tracks.length,
                   kinds: [...new Set(s.view.tracks.map((t) => t.kind))],
                   hidden: s.hiddenTracks.size, total: s.project.tracks.length,
                   chipOn: [...document.querySelectorAll('#track-menu-filter .kind-chip.on')].map((b) => b.dataset.kind),
                   status: document.getElementById('status-text').textContent };
        })()`);
        // 再点"全部"回到全显示
        const allPos = await evalJs(`(() => {
          const b = [...document.querySelectorAll('#track-menu-filter .kind-chip')]
            .find((x) => x.dataset.kind === '');
          const r = b.getBoundingClientRect();
          return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
        })()`);
        await clickAt(allPos.x, allPos.y);
        await sleep(400);
        const back = await evalJs(`(() => {
          const s = window.dawview.state;
          return { filter: s.kindFilter, hidden: s.hiddenTracks.size, viewTracks: s.view.tracks.length };
        })()`);
        return {
          pass: chipsOk && counts.automation === 3
                && st.filter === 'automation' && st.viewTracks === 3
                && st.kinds.length === 1 && st.kinds[0] === 'automation'
                && st.hidden === st.total - 3
                && st.chipOn.length === 1 && st.chipOn[0] === 'automation'
                && /隐藏 9/.test(st.status)
                && back.filter === '' && back.hidden === 0 && back.viewTracks === 12,
          detail: JSON.stringify({ chips, counts, st, back }),
        };
      }],

      ['渐变上色：色卡 / RGB 两档，低饱和、各不相同、能清除', async () => {
        const reset = () => evalJs(`(() => {
          const dv = window.dawview;
          dv.state.trackColors = {}; dv.saveTrackColors();
          dv.state.hiddenTracks.clear(); dv.state.kindFilter = '';
          dv.applyTrackFilter();
          dv.toggleTrackMenu(true);
          dv.setViewMode('arrange');
        })()`);
        const read = () => evalJs(`(() => {
          const dv = window.dawview, list = dv.state.view.tracks;
          const cols = list.map((t) => dv.trackColorHex(t.projectIndex));
          const hsl = cols.map((hex) => {
            const { r, g, b } = dv.hexToRgb(hex);
            const [h, s, l] = dv.rgbToHsl(r, g, b);
            return { h, s, l };
          });
          const bucket = JSON.parse(localStorage.getItem('dawview.trackColors') || '{}');
          return { n: list.length, set: cols.filter(Boolean).length, uniq: new Set(cols).size,
                   maxS: Math.max(...hsl.map((x) => x.s)), minS: Math.min(...hsl.map((x) => x.s)),
                   hues: hsl.map((x) => x.h), first: cols[0], last: cols[cols.length - 1],
                   lsCount: Object.keys(bucket[Object.keys(bucket)[0]] || {}).length };
        })()`);
        const clickBtn = async (id) => {
          const p = await evalJs(`(() => {
            const r = document.getElementById('${id}').getBoundingClientRect();
            return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
          })()`);
          await clickAt(p.x, p.y);
          await sleep(400);
        };

        await reset();
        await clickBtn('btn-grad-rgb');
        const rgb = await read();
        const hueSpan = Math.max(...rgb.hues) - Math.min(...rgb.hues);
        const rgbOk = rgb.n === 12 && rgb.set === 12 && rgb.uniq === 12
                      && rgb.maxS <= 0.5 && rgb.minS >= 0.2 && hueSpan > 200 && rgb.lsCount === 12;

        // 真的画到画布上了：拿一条音频片段（假波形只在开头 120px）的平涂段
        // 和分配色比对 —— 底色是 0.16 透明度压在行底色上，只能比"混出来的颜色"
        const c = await themeColors();
        const row = await clipRow('audio', [200, 900]);
        const want = await evalJs(`window.dawview.trackColorHex(${row.pi})`);
        const blend = (hex) => [0, 1, 2].map((i) => Math.round(hex2rgb(c.bg)[i] * 0.84 + hex2rgb(hex)[i] * 0.16));
        const dCanvas = dist(mean(row.px), blend(want));

        await reset();
        await clickBtn('btn-grad-palette');
        const pal = await read();
        const palHues = await evalJs(`window.dawview.SWATCH_PALETTE.map((h) => {
          const { r, g, b } = window.dawview.hexToRgb(h);
          return window.dawview.rgbToHsl(r, g, b)[0];
        })`);
        const inRange = pal.hues.every((h) => h >= Math.min(...palHues) - 6 && h <= Math.max(...palHues) + 6);
        const palOk = pal.n === 12 && pal.set === 12 && pal.uniq === 12
                      && pal.maxS <= 0.52 && inRange && pal.first !== rgb.first;

        // 清除
        await clickBtn('btn-grad-clear');
        const cleared = await evalJs(`(() => {
          const dv = window.dawview;
          const bucket = JSON.parse(localStorage.getItem('dawview.trackColors') || '{}');
          return { colors: Object.keys(dv.state.trackColors).length,
                   bucketKeys: Object.keys(bucket).length };
        })()`);

        return {
          pass: rgbOk && dCanvas < 14 && palOk && cleared.colors === 0 && cleared.bucketKeys === 0,
          detail: JSON.stringify({ rgb, hueSpan: Math.round(hueSpan), dCanvas: +dCanvas.toFixed(1),
                                   want, pal, inRange, cleared }),
        };
      }],

    ];

    for (const [name, fn] of flChecks) {
      flRan++;
      step(name);
      try {
        const r = await fn();
        console.log(`  ${r.pass ? 'PASS' : 'FAIL'} ${r.detail ?? ''}`);
        if (!r.pass) failed++;
      } catch (err) {
        console.log(`  ERROR ${err.message}`);
        failed++;
      }
    }

    await evalJs(`(() => {
      const dv = window.dawview;
      dv.setViewMode('arrange');
      dv.state.pxPerTick = 0.03;
      dv.rebuildView();
      document.getElementById('scroll').scrollLeft = 0;
      document.getElementById('scroll').scrollTop = 0;
      dv.paint();
    })()`);
    await sleep(300);
    await shot('shot-fl.png');

    // 复原固定快照：下轮验证（或用户直接开页面）看到的还是 Cubase 那份
    if (existsSync(fixture)) {
      copyFileSync(fixture, live);
      await evalJs(`location.reload()`);
      await sleep(1500);
    }
  }

  // ==================== 速度轨快照（任意带变速的工程） ====================
  // 只有真·变速工程才验得出"播放头推进速率跟着速度轨走"。生成方法：
  //   python scripts/make-fixture.py "你的变速工程.cpr"      # 覆盖 Cubase 那份
  //   python scripts/make-fixture.py "你的变速工程.flp" --out scripts/fixture-project-tempo.json
  let tempoRan = 0;
  if (existsSync(tempoFixture)) {
    step(`速度轨快照（${tempoFixture.split(/[\\/]/).pop()}）`);
    copyFileSync(tempoFixture, live);
    await evalJs(`location.reload()`);
    await sleep(2500);

    const tempoChecks = [
      ['速度轨解析成多段阶梯：点数 > 100、tick 单调、首点 0', async () => {
        const r = await evalJs(`(() => {
          const dv = window.dawview;
          const t = dv.state.tempo;
          let mono = true;
          for (let i = 1; i < t.ticks.length; i++) if (t.ticks[i] <= t.ticks[i - 1]) mono = false;
          const distinct = new Set(t.bpms.map((b) => Math.round(b * 100))).size;
          return { points: t.points, first: t.ticks[0], mono, distinct,
                   bpm0: +t.bpmAt(0).toFixed(3), bpmMid: +t.bpmAt(t.ticks[Math.floor(t.ticks.length / 2)]).toFixed(3),
                   total: +t.totalSec.toFixed(3), metaBpm: dv.state.project.meta.bpm };
        })()`);
        return { pass: r.points > 100 && r.first === 0 && r.mono && r.distinct > 20,
                 detail: JSON.stringify(r) };
      }],

      ['secAt / tickAtSec 互为反函数（阶梯积分自洽）', async () => {
        const r = await evalJs(`(() => {
          const t = window.dawview.state.tempo;
          let worst = 0;
          let worstTick = 0;
          const stepN = Math.max(1, Math.floor(t.ticks.length / 50));
          for (let i = 0; i < t.ticks.length; i += stepN) {
            const err = Math.abs(t.tickAtSec(t.secAt(t.ticks[i])) - t.ticks[i]);
            if (err > worst) { worst = err; worstTick = t.ticks[i]; }
          }
          return { worst, worstTick, points: t.points };
        })()`);
        return { pass: r.worst < 1e-3, detail: JSON.stringify(r) };
      }],

      ['变速播放：快段推进速率 / 慢段推进速率 ≈ 两段 BPM 之比', async () => {
        const plan = await evalJs(`(() => {
          const dv = window.dawview;
          const pick = () => {
            // 只挑"局部稳定"的候选：0.5 秒窗口内速度变化 <= 5%。
            // Cubase 那种阶梯里能找到长平台，FL 那种密集斜坡也能（斜坡够缓）。
            const t = dv.state.tempo;
            const out = [];
            for (let i = 0; i < t.ticks.length - 1; i++) {
              const b0 = t.bpms[i];
              const span = (b0 / 60) * t.ppq * 0.6;
              let j = i;
              let lo = b0;
              let hi = b0;
              while (j + 1 < t.ticks.length && t.ticks[j + 1] - t.ticks[i] <= span) {
                j++;
                lo = Math.min(lo, t.bpms[j]);
                hi = Math.max(hi, t.bpms[j]);
              }
              if (hi <= lo * 1.05) out.push({ tick: t.ticks[i] + 1, bpm: b0 });
            }
            if (!out.length) return { fast: null, slow: null };
            let fast = out[0];
            let slow = out[0];
            for (const c of out) {
              if (c.bpm > fast.bpm) fast = c;
              if (c.bpm < slow.bpm) slow = c;
            }
            return { fast, slow, candidates: out.length };
          };
          return pick();
        })()`);
        if (!plan.fast || !plan.slow || plan.fast.bpm <= plan.slow.bpm * 1.05) {
          return { pass: true, detail: '这个工程的变速差得不够（跳过）：' + JSON.stringify(plan) };
        }
        // 手动喂 30 帧（16.7ms 一帧）——不依赖真实 rAF，测出来是确定的
        const drive = (tick) => `(() => {
          const dv = window.dawview;
          dv.state.playing = true;
          dv.state.playheadTick = ${tick};
          dv.state.lastTs = 0;
          let ts = performance.now();
          for (let i = 0; i < 30; i++) { ts += 16.7; dv.frame(ts); }
          dv.state.playing = false;
          return dv.state.playheadTick - ${tick};
        })()`;
        const dFast = await evalJs(drive(plan.fast.tick));
        const dSlow = await evalJs(drive(plan.slow.tick));
        const want = plan.fast.bpm / plan.slow.bpm;
        const got = dSlow > 0 ? dFast / dSlow : 0;
        return { pass: dFast > 0 && dSlow > 0 && Math.abs(got - want) / want < 0.15,
                 detail: JSON.stringify({ fast: { ...plan.fast, d: Math.round(dFast) },
                                          slow: { ...plan.slow, d: Math.round(dSlow) },
                                          want: +want.toFixed(3), got: +got.toFixed(3) }) };
      }],

      ['走带标签显示当前速度（变速区里会变）', async () => {
        const r = await evalJs(`(() => {
          const dv = window.dawview;
          const pick = () => {
            // 只挑"局部稳定"的候选：0.5 秒窗口内速度变化 <= 5%。
            // Cubase 那种阶梯里能找到长平台，FL 那种密集斜坡也能（斜坡够缓）。
            const t = dv.state.tempo;
            const out = [];
            for (let i = 0; i < t.ticks.length - 1; i++) {
              const b0 = t.bpms[i];
              const span = (b0 / 60) * t.ppq * 0.6;
              let j = i;
              let lo = b0;
              let hi = b0;
              while (j + 1 < t.ticks.length && t.ticks[j + 1] - t.ticks[i] <= span) {
                j++;
                lo = Math.min(lo, t.bpms[j]);
                hi = Math.max(hi, t.bpms[j]);
              }
              if (hi <= lo * 1.05) out.push({ tick: t.ticks[i] + 1, bpm: b0 });
            }
            if (!out.length) return { fast: null, slow: null };
            let fast = out[0];
            let slow = out[0];
            for (const c of out) {
              if (c.bpm > fast.bpm) fast = c;
              if (c.bpm < slow.bpm) slow = c;
            }
            return { fast, slow, candidates: out.length };
          };
          const plan = pick();
          if (!plan.fast || !plan.slow) return { skip: true };
          const read = (tick) => { dv.state.playheadTick = tick; dv.updatePosLabel();
                                   return document.getElementById('pos-label').textContent; };
          return { fast: read(plan.fast.tick), slow: read(plan.slow.tick),
                   a: +plan.fast.bpm.toFixed(1), b: +plan.slow.bpm.toFixed(1) };
        })()`);
        if (r.skip) return { pass: true, detail: '没有局部稳定的变速段（跳过）' };
        return { pass: r.fast.includes(`${r.a.toFixed(1)} BPM`) && r.slow.includes(`${r.b.toFixed(1)} BPM`)
                       && r.fast !== r.slow,
                 detail: JSON.stringify(r) };
      }],

      ['钢琴窗下部：CC 栏画出来了（有 CC 数据才跑）', async () => {
        const r = await evalJs(`(() => {
          const dv = window.dawview;
          const choices = dv.ccChoices();
          if (!choices.length) return { skip: true };
          const cc = choices[0].cc;
          const c = document.getElementById('tl');
          const g = c.getContext('2d');
          const dpr = window.devicePixelRatio || 1;
          const h = c.clientHeight;
          const band = () => {
            const d = g.getImageData(0, Math.round((h - 120) * dpr), c.width, Math.round(120 * dpr)).data;
            let n = 0;
            for (let i = 0; i < d.length; i += 4) if (d[i] > 60 || d[i + 1] > 60 || d[i + 2] > 60) n++;
            return n;
          };
          dv.setViewMode('midi');
          dv.state.lanes = [];
          dv.rebuildView();
          dv.paint();
          const before = band();
          dv.addLane({ kind: 'cc', cc });
          dv.paint();
          const after = band();
          const lay = dv.laneLayout(dv.state.view, h);
          return { cc, before, after, total: lay.total, points: dv.state.view.ccs.find((e) => e.cc === cc).points.length };
        })()`);
        if (r.skip) return { pass: true, detail: '这个工程没有 CC 数据（跳过）' };
        return { pass: r.total > 0 && r.after > r.before + 300,
                 detail: JSON.stringify(r) };
      }],
    ];

    for (const [name, fn] of tempoChecks) {
      tempoRan++;
      step(name);
      try {
        const r = await fn();
        console.log(`  ${r.pass ? 'PASS' : 'FAIL'} ${r.detail ?? ''}`);
        if (!r.pass) failed++;
      } catch (err) {
        console.log(`  ERROR ${err.message}`);
        failed++;
      }
    }

    await evalJs(`(() => {
      const dv = window.dawview;
      dv.state.lanes = [];
      dv.setViewMode('arrange');
      dv.state.playheadTick = 0;
      dv.rebuildView();
      dv.paint();
    })()`);
    await sleep(300);
    await shot('shot-tempo.png');

    if (existsSync(fixture)) {          // 复原固定快照
      copyFileSync(fixture, live);
      await evalJs(`location.reload()`);
      await sleep(1500);
    }
  }

  // ==================== REAPER（.rpp）快照 ====================
  // .rpp 是**纯文本**工程（不像 .cpr/.flp 是二进制），时间全都用秒写，
  // 解析器要按速度轨积分成 tick。这一段验证"契约字段（ppq=960、文件夹轨、
  // 音频/MIDI 片段、CC）前端真的按 REAPER 那份数据画"。
  let reaperRan = 0;
  if (existsSync(reaperFixture)) {
    step(`REAPER 工程快照（${reaperFixture.split(/[\\/]/).pop()}）`);
    copyFileSync(reaperFixture, live);
    await evalJs(`location.reload()`);
    await sleep(2500);

    const reaperChecks = [
      ['REAPER 元信息（宿主 / 速度 / 拍号 / ppq=960 / 采样率）', async () => {
        // 顶栏那行不显示 ppq，ppq 直接从载入进来的契约里读
        const t = await evalJs(`(() => {
          const m = window.dawview.state.project.meta;
          return { text: document.getElementById('proj-info').textContent, ppq: m.ppq };
        })()`);
        return { pass: /dnb/.test(t.text) && /\breaper\b/.test(t.text) && /7\.67/.test(t.text)
                      && /190 BPM/.test(t.text) && /4\/4/.test(t.text)
                      && /44100/.test(t.text) && t.ppq === 960,
                 detail: JSON.stringify(t) };
      }],

      ['REAPER 轨道/片段种类齐全（文件夹轨也在）', async () => {
        const d = await evalJs(`(() => {
          const s = window.dawview.state.project, tk = {}, ck = {};
          let notes = 0;
          for (const t of s.tracks) {
            tk[t.kind] = (tk[t.kind] || 0) + 1;
            for (const c of t.clips) {
              ck[c.kind] = (ck[c.kind] || 0) + 1;
              notes += (c.notes || []).length;
            }
          }
          return { tracks: s.tracks.length, tk, ck, notes };
        })()`);
        return {
          pass: d.tracks === 11 && d.tk.folder === 3 && d.tk.audio === 3 && d.tk.midi === 2
                && d.tk.instrument === 3 && d.ck.audio === 18 && d.ck.midi === 6 && d.notes === 272,
          detail: JSON.stringify(d),
        };
      }],

      ['轨道菜单里文件夹轨显示中文「文件夹」', async () => {
        await evalJs(`window.dawview.renderTrackMenu()`);
        const txt = await evalJs(`document.getElementById('track-menu-list').textContent`);
        return { pass: /文件夹/.test(txt) && !/folder/.test(txt), detail: txt.slice(0, 120) };
      }],

      ['ppq=960 的走带标尺（3840 tick = 第 2 小节 · 190 BPM）', async () => {
        const label = await evalJs(`(() => {
          const dv = window.dawview;
          dv.state.playheadTick = 3840;      // 960 ppq -> 3840 tick = 4 拍 = 1 小节
          dv.updatePosLabel();
          return document.getElementById('pos-label').textContent;
        })()`);
        return { pass: /^2\.1\.0 · 190(\.0)? BPM$/.test(label.trim()), detail: label };
      }],

      ['钢琴窗：REAPER 的音符画出来了（音区按音符自动定）', async () => {
        const r = await evalJs(`(() => {
          const dv = window.dawview;
          dv.setViewMode('midi');
          dv.state.hiddenTracks.clear();
          dv.state.kindFilter = '';
          dv.rebuildView();
          dv.paint();
          const v = dv.state.view;
          const pitches = v.notes.map((n) => n.pitch);
          return { n: v.notes.length, lo: dv.state.pitchLo, hi: dv.state.pitchHi,
                   min: Math.min(...pitches), max: Math.max(...pitches) };
        })()`);
        // 合成快照里音高 36..78 -> 音区留 2 个半音余量
        return { pass: r.n === 272 && r.lo === 34 && r.hi === 80,
                 detail: JSON.stringify(r) };
      }],

      ['CC 栏能选到 REAPER 的控制器（CC123 全部音符关）', async () => {
        const r = await evalJs(`(() => {
          const dv = window.dawview;
          dv.setViewMode('midi');
          dv.state.lanes = [];
          dv.rebuildView();
          const c = document.getElementById('tl');
          const g = c.getContext('2d');
          const dpr = window.devicePixelRatio || 1;
          const h = c.clientHeight;
          const band = () => {
            const d = g.getImageData(0, Math.round((h - 120) * dpr), c.width, Math.round(120 * dpr)).data;
            let n = 0;
            for (let i = 0; i < d.length; i += 4) if (d[i] > 60 || d[i + 1] > 60 || d[i + 2] > 60) n++;
            return n;
          };
          dv.paint();
          const before = band();
          dv.addLane({ kind: 'cc', cc: 123 });
          dv.paint();
          const after = band();
          const lay = dv.laneLayout(dv.state.view, h);
          return { choices: dv.ccChoices(), before, after, total: lay.total };
        })()`);
        const line = (r.choices || []).find((c) => c.cc === 123);
        // 单点 CC 画在片段最末尾，不落在采样的那一段里 —— 这里只认
        // "下拉里能选到它" + "栏位真的占了高度"，像素断言交给上面那份 FL 的（他有 30 点）
        return { pass: !!line && line.name === '全部音符关' && line.n === 6 && r.total > 0,
                 detail: JSON.stringify(r) };
      }],
    ];

    for (const [name, fn] of reaperChecks) {
      reaperRan++;
      step(name);
      try {
        const r = await fn();
        console.log(`  ${r.pass ? 'PASS' : 'FAIL'} ${r.detail ?? ''}`);
        if (!r.pass) failed++;
      } catch (err) {
        console.log(`  ERROR ${err.message}`);
        failed++;
      }
    }

    await evalJs(`(() => {
      const dv = window.dawview;
      dv.state.lanes = [];
      dv.setViewMode('arrange');
      dv.state.pxPerTick = 0.06;
      dv.state.playheadTick = 0;
      dv.rebuildView();
      document.getElementById('scroll').scrollLeft = 0;
      document.getElementById('scroll').scrollTop = 0;
      dv.paint();
    })()`);
    await sleep(300);
    await shot('shot-reaper.png');

    if (existsSync(fixture)) {          // 复原固定快照
      copyFileSync(fixture, live);
      await evalJs(`location.reload()`);
      await sleep(1500);
    }
  }


  // ==================== Bitwig（.bwproject）快照 ====================
  // .bwproject 是二进制容器：头部 + meta 块 + "元素流"文档。片段的位置/时长写在片段
  // 自己的字段区里（复制粘贴出来的副本各自是独立片段对象）；音高不在音符元素上，一个
  // 音高一条"音高轨"，音高写在 lane footer 里，取"音符后面第一个 footer"。
  // 这一段验证契约字段（31 轨 / 44 MIDI 片段 / 2363 音符 / 548 音频片段）和前端画法。
  let bitwigRan = 0;
  if (existsSync(bitwigFixture)) {
    step(`Bitwig 工程快照（${bitwigFixture.split(/[\/]/).pop()}）`);
    copyFileSync(bitwigFixture, live);
    await evalJs(`location.reload()`);
    await sleep(2500);

    const bitwigChecks = [
      ['Bitwig 元信息（宿主 / 5.3.13 / 124 BPM / ppq=480 / 采样率）', async () => {
        const t = await evalJs(`(() => {
          const m = window.dawview.state.project.meta;
          return { text: document.getElementById('proj-info').textContent, ppq: m.ppq };
        })()`);
        return { pass: /house/.test(t.text) && /\bbitwig\b/.test(t.text)
                      && /5\.3\.13/.test(t.text) && /124 BPM/.test(t.text)
                      && /4\/4/.test(t.text) && /44100/.test(t.text)
                      && t.ppq === 480,
                 detail: JSON.stringify(t) };
      }],

      ['Bitwig 轨道/片段/音符总数（快照裁剪后：3 乐器 + 3 音频 + 3 总线 / 981 音符）', async () => {
        const d = await evalJs(`(() => {
          const s = window.dawview.state.project, tk = {}, ck = {};
          let notes = 0;
          for (const t of s.tracks) {
            tk[t.kind] = (tk[t.kind] || 0) + 1;
            for (const c of t.clips) {
              ck[c.kind] = (ck[c.kind] || 0) + 1;
              notes += (c.notes || []).length;
            }
          }
          return { tracks: s.tracks.length, tk, ck, notes };
        })()`);
        // 完整工程是 31 轨 / 44 MIDI 片段 / 548 音频片段 / 2363 音符；
        // 快照按 make-fixture 的规则只留每类 3 轨、每轨最多 6 个片段
        return { pass: d.tracks === 9 && d.tk.instrument === 3 && d.tk.audio === 3
                      && d.tk.bus === 3 && d.ck.midi === 14 && d.ck.audio === 18 && d.notes === 981,
                 detail: JSON.stringify(d) };
      }],

      ['Bitwig 复制粘贴出来的片段一段都没丢（吉他轨 6 段，位置逐段对）', async () => {
        const r = await evalJs(`(() => {
          const s = window.dawview.state.project;
          const g = s.tracks.find((t) => t.name === 'Ample Guitar SJ') || { clips: [] };
          return { n: g.clips.length, pos: g.clips.map((c) => c.startTick / 480) };
        })()`);
        return { pass: r.n === 6
                      && JSON.stringify(r.pos) === JSON.stringify([7, 40, 72, 104, 136, 168]),
                 detail: JSON.stringify(r) };
      }],

      ['Bitwig 片段归到对的轨道上（乐器轨的音区 / 音频轨的采样名各自对上）', async () => {
        const r = await evalJs(`(() => {
          const s = window.dawview.state.project;
          const t = (n) => s.tracks.find((x) => x.name === n) || { clips: [] };
          const range = (n) => {
            const ps = t(n).clips.flatMap((c) => (c.notes || []).map((x) => x.pitch));
            return ps.length ? [Math.min(...ps), Math.max(...ps)] : [];
          };
          return { guitarT: range('Ample Guitar T'), bass: range('Ample Bass J'),
                   kick: [...new Set(t('DS_SPP2_kick_one_shot_acoustic_optimized')
                                     .clips.map((c) => c.audioFile))],
                   tamb: [...new Set(t('KSHMR_Tambourine_02').clips.map((c) => c.audioFile))] };
        })()`);
        // 快照里 3 条乐器轨各是一把吉他 / 贝斯（音区要合常理），3 条音频轨是鼓组轨
        // （只有音频片段；它们是"采样器重采样"，轨道名和采样文件名不同名）
        return { pass: r.guitarT[0] >= 36 && r.guitarT[1] <= 78
                      && r.bass[0] >= 36 && r.bass[1] <= 60
                      && JSON.stringify(r.kick) === JSON.stringify(['KSHMR Acoustic Kick 12 - Hard.wav'])
                      && JSON.stringify(r.tamb) === JSON.stringify(['KSHMR_Tambourine_01.wav']),
                 detail: JSON.stringify(r) };
      }],

      ['Bitwig 片段的"内容窗口"用上了：吉他轨第一段的音符按窗口起点 -1 拍摆放', async () => {
        // 片段记录尾部那对 {0x98c}/{0x98d} 存的是"这个片段显示 pattern 里的哪一段"（pattern
        // 坐标）。吉他轨第一段（7..40 拍）窗口是 -1..32、比其他段宽 1 拍 —— 按窗口起点 0 摆
        // 整段音符就整体差 1 拍（用户照 Bitwig 看出来的那个）。
        const r = await evalJs(`(() => {
          const s = window.dawview.state.project;
          const g = s.tracks.find((t) => t.name === 'Ample Guitar SJ');
          const c0 = g.clips[0], c1 = g.clips[1];
          const at = (c) => Math.min(...c.notes.map((n) => n.startTick));
          return { c0Start: c0.startTick / 480, c0Len: c0.lengthTick / 480, c0First: at(c0) / 480,
                   c1First: at(c1) / 480, c0Notes: c0.notes.length, c1Notes: c1.notes.length };
        })()`);
        // 第一段：片段起点 7 拍、里面第一个音符是起拍装饰音（相对 0.875 拍 → 绝对 7.875 拍；
        // 不按窗口挪的话这里会是 -0.125 拍）；第二段窗口起点是 0，音符相对位置不挪，
        // 但它那个 -1/8 拍的起拍音落在窗口外、被丢掉（55 → 54）
        return { pass: r.c0Start === 7 && r.c0Len === 33 && r.c0First === 0.875
                      && r.c1First === 0 && r.c0Notes === 59 && r.c1Notes === 54,
                 detail: JSON.stringify(r) };
      }],

      ['钢琴窗：Bitwig 的音符画出来了（音高按音高轨 footer 取值，快照里 37..96）', async () => {
        const r = await evalJs(`(() => {
          const dv = window.dawview;
          dv.setViewMode('midi');
          dv.state.hiddenTracks.clear();
          dv.state.kindFilter = '';
          dv.rebuildView();
          dv.paint();
          const v = dv.state.view;
          const pitches = v.notes.map((n) => n.pitch);
          return { n: v.notes.length, lo: dv.state.pitchLo, hi: dv.state.pitchHi,
                   min: Math.min(...pitches), max: Math.max(...pitches) } ;
        })()`);
        // 快照里是 3 条乐器轨的 981 个音符（音高 37..96）-> 音区留 2 个半音余量
        return { pass: r.n === 981 && r.lo === 35 && r.hi === 98,
                 detail: JSON.stringify(r) };
      }],
    ];

    for (const [name, fn] of bitwigChecks) {
      bitwigRan++;
      step(name);
      try {
        const r = await fn();
        console.log(`  ${r.pass ? 'PASS' : 'FAIL'} ${r.detail ?? ''}`);
        if (!r.pass) failed++;
      } catch (err) {
        console.log(`  ERROR ${err.message}`);
        failed++;
      }
    }

    await evalJs(`(() => {
      const dv = window.dawview;
      dv.state.lanes = [];
      dv.setViewMode('arrange');
      dv.state.pxPerTick = 0.06;
      dv.state.playheadTick = 0;
      dv.rebuildView();
      document.getElementById('scroll').scrollLeft = 0;
      document.getElementById('scroll').scrollTop = 0;
      dv.paint();
    })()`);
    await sleep(300);
    await shot('shot-bitwig.png');

    if (existsSync(fixture)) {          // 复原固定快照
      copyFileSync(fixture, live);
      await evalJs(`location.reload()`);
      await sleep(1500);
    }
  }

  // ==================== Studio One（.song）快照 ====================
  // .song 是个 ZIP：metainfo.xml（标题/速度/采样率）+ Song/song.xml（走带 + 轨道事件）
  // + Song/mediapool.xml（mediaID → 文件路径）+ Performances/<乐器>/<名>(n).musicx
  // （二进制演奏文件，音符在这里）。两个坑决定了画面对不对：
  //   (1) **位置单位跟轨道 tempoFollow 走**（0 = 秒、2 = 拍），长度单位跟事件 timeFormat
  //       走（0 = 秒、2 = 拍）—— 两套单位分开决定，这工程的音频轨正好两类都有；
  //   (2) **片段是窗口**：音符坐标在源演奏文件里，MusicPart 的 offset 是片段左缘，
  //       窗口外的音符在 Studio One 里不属于该片段。
  // 完整工程：62 轨（39 音频 + 17 乐器 + 1 MIDI + 5 总线）/ 98 个 MIDI 片段 +
  // 1942 个音频片段 / 11530 个音符（另有 761 个落在片段内容窗口之外被丢掉）。
  let studioOneRan = 0;
  if (existsSync(studioOneFixture)) {
    step(`Studio One 工程快照（${studioOneFixture.split(/[\/]/).pop()}）`);
    copyFileSync(studioOneFixture, live);
    await evalJs(`location.reload()`);
    await sleep(2500);

    const studioOneChecks = [
      ['Studio One 元信息（宿主 / 7.1.0.104182 / 162 BPM / 4/4 / 48000 / ppq=480）', async () => {
        const t = await evalJs(`(() => {
          const m = window.dawview.state.project.meta;
          return { text: document.getElementById('proj-info').textContent, ppq: m.ppq,
                   host: m.host };
        })()`);
        return { pass: t.host === 'studioone' && /7\.1\.0\.104182/.test(t.text)
                      && /162 BPM/.test(t.text) && /4\/4/.test(t.text)
                      && /48000/.test(t.text) && t.ppq === 480,
                 detail: JSON.stringify(t) };
      }],

      ['Studio One 轨道/片段/音符总数（快照裁剪后：3 乐器 + 1 MIDI + 3 音频 + 3 总线 / 1386 音符）', async () => {
        const d = await evalJs(`(() => {
          const s = window.dawview.state.project, tk = {}, ck = {};
          let notes = 0;
          for (const t of s.tracks) {
            tk[t.kind] = (tk[t.kind] || 0) + 1;
            for (const c of t.clips) {
              ck[c.kind] = (ck[c.kind] || 0) + 1;
              notes += (c.notes || []).length;
            }
          }
          return { tracks: s.tracks.length, tk, ck, notes };
        })()`);
        // 完整工程是 62 轨 / 98 MIDI + 1942 音频 / 11530 音符；
        // 快照按 make-fixture 的规则只留每类 3 轨、每轨最多 6 个片段
        // （18 条 Music 轨里有 1 条没挂乐器 —— 快照里就是那条纯 MIDI 的 "Track"）
        return { pass: d.tracks === 10 && d.tk.instrument === 3 && d.tk.midi === 1
                      && d.tk.audio === 3 && d.tk.bus === 3
                      && d.ck.midi === 13 && d.ck.audio === 18 && d.notes === 1386,
                 detail: JSON.stringify(d) };
      }],

      ['Studio One 两个片段各自对上源演奏文件（音符数不多不少）', async () => {
        const r = await evalJs(`(() => {
          const s = window.dawview.state.project;
          const t = (n) => s.tracks.find((x) => x.name === n) || { clips: [] };
          return { piano: t('Pianoteq 6 (64-bit)').clips.map((c) => [c.startTick / 480,
                                                                    c.notes.length]),
                   m1: t('M1').clips.map((c) => [c.startTick / 480, c.lengthTick / 480,
                                                 c.notes.length]) };
        })()`);
        // 演奏文件 M1(42) 有 160 个音符 / M1(43) 有 152 个 —— 片段长度 64 / 62 拍，
        // offset ≈ 0，所以窗口里一个都不用丢
        return { pass: JSON.stringify(r.piano) === JSON.stringify([[0, 224], [64, 224],
                                                                    [128, 224], [576, 224]])
                      && JSON.stringify(r.m1) === JSON.stringify([[192, 64, 160],
                                                                  [256, 62, 152]]),
                 detail: JSON.stringify(r) };
      }],

      ['Studio One 力度取文件里存的值（快照 43 档；M1 那条轨 43 档 39..84）', async () => {
        const r = await evalJs(`(() => {
          const s = window.dawview.state.project;
          const vs = s.tracks.flatMap((t) => t.clips.flatMap((c) => (c.notes || []).map((n) => n.velocity)));
          const m1 = s.tracks.find((x) => x.name === 'M1').clips[0].notes.map((n) => n.velocity);
          return { total: vs.length, levels: new Set(vs).size, m1Levels: new Set(m1).size,
                   m1Min: Math.min(...m1), m1Max: Math.max(...m1) };
        })()`);
        // 曾经错在"把 quantize.velocity 加到力度上"：那样整份工程只剩 76 / 102 两档
        return { pass: r.levels === 43 && r.m1Levels === 43 && r.m1Min === 39 && r.m1Max === 84,
                 detail: JSON.stringify(r) };
      }],

      ['Studio One 位置单位：不跟速度的轨（tempoFollow=0）存的是秒，落回网格上是整数拍', async () => {
        const r = await evalJs(`(() => {
          const s = window.dawview.state.project;
          const k = s.tracks.find((t) => t.name.startsWith('KSHMR Acoustic Kick'));
          return { beats: k.clips.map((c) => c.startTick / 480) };
        })()`);
        // 文件里存的是 94.8148…、96.2962… 这种"秒"，× 162/60 才是拍
        // （24 个事件 100% 落在整拍网格上）
        return { pass: JSON.stringify(r.beats) === JSON.stringify([256, 260, 261, 264, 268, 269]),
                 detail: JSON.stringify(r) };
      }],

      ['Studio One 长度单位：timeFormat=0 的音频事件长度按秒算（军鼓 0.536 秒 = 695.2 tick）', async () => {
        const r = await evalJs(`(() => {
          const s = window.dawview.state.project;
          const t = s.tracks.find((x) => x.name.startsWith('KSHMR Acoustic Snare'));
          return { lens: t.clips.map((c) => Math.round(c.lengthTick * 1000) / 1000),
                   file: t.clips[0].audioFile };
        })()`);
        // 0.536417… 秒 × 162/60 × 480 = 695.197 tick（六段长度都一样：同一个采样文件）
        const want = Math.round(0.5364172335600907 * 162 / 60 * 480 * 1000) / 1000;
        return { pass: r.lens.every((x) => x === want)
                      && /KSHMR Acoustic Snare 13\.wav$/.test(r.file),
                 detail: JSON.stringify({ len: want, ...r }) };
      }],

      ['Studio One 音频片段带采样路径（工程旁边的文件 + 导出的 Bounce）', async () => {
        const r = await evalJs(`(() => {
          const s = window.dawview.state.project;
          return { files: [...new Set(s.tracks.filter((t) => t.kind === 'audio')
                              .flatMap((t) => t.clips.map((c) => c.audioFile)))] };
        })()`);
        return { pass: r.files.length === 4
                      && r.files.some((f) => /KSHMR Acoustic Kick 18 - Hard\.wav$/.test(f))
                      && r.files.some((f) => /KSHMR Acoustic Snare 13\.wav$/.test(f))
                      && r.files.some((f) => /Bounces[\/]Mixdown\.wav$/.test(f)),
                 detail: JSON.stringify(r.files.map((f) => f.split(/[\/]/).pop())) };
      }],

      ['钢琴窗：Studio One 的音符画出来了（快照里 1386 个，音区 38..83）', async () => {
        const r = await evalJs(`(() => {
          const dv = window.dawview;
          dv.setViewMode('midi');
          dv.state.hiddenTracks.clear();
          dv.state.kindFilter = '';
          dv.rebuildView();
          dv.paint();
          const v = dv.state.view;
          const pitches = v.notes.map((n) => n.pitch);
          return { n: v.notes.length, lo: dv.state.pitchLo, hi: dv.state.pitchHi,
                   min: Math.min(...pitches), max: Math.max(...pitches) };
        })()`);
        return { pass: r.n === 1386 && r.min === 38 && r.max === 83 && r.lo === 36 && r.hi === 85,
                 detail: JSON.stringify(r) };
      }],
    ];

    for (const [name, fn] of studioOneChecks) {
      studioOneRan++;
      step(name);
      try {
        const r = await fn();
        console.log(`  ${r.pass ? 'PASS' : 'FAIL'} ${r.detail ?? ''}`);
        if (!r.pass) failed++;
      } catch (err) {
        console.log(`  ERROR ${err.message}`);
        failed++;
      }
    }

    await evalJs(`(() => {
      const dv = window.dawview;
      dv.state.lanes = [];
      dv.setViewMode('arrange');
      dv.state.pxPerTick = 0.06;
      dv.state.playheadTick = 0;
      dv.rebuildView();
      document.getElementById('scroll').scrollLeft = 0;
      document.getElementById('scroll').scrollTop = 0;
      dv.paint();
    })()`);
    await sleep(300);
    await shot('shot-studioone.png');

    if (existsSync(fixture)) {          // 复原固定快照
      copyFileSync(fixture, live);
      await evalJs(`location.reload()`);
      await sleep(1500);
    }
  }

  // ==================== MIDI（.mid）快照 ====================
  // .mid 是标准 MIDI 文件：MThd + 若干 MTrk，事件流 = "变长量 delta + 状态字节"，
  // 状态字节可以整个省掉（运行状态，实测真文件 64% 的事件走这条路）。它**没有"片段"
  // 这一层** —— 解析器的映射是"一条 MTrk = 一条轨道、整条轨一个片段"（起点 0、
  // 长度到该轨内容末尾）。这份快照来自 MuseScore 导出的管弦乐
  // （完整文件 39 条 MTrk / 5346 音符 / 216 个速度点 / 7 种 CC），
  // 快照按 make-fixture 的规则只留前 3 条轨。
  // 两处只有实测才知道的坑写在这里：
  //   (1) **末尾那条超远速度点**：MuseScore 会在远超内容末尾的 tick 上再写一条速度
  //       （内容到 264981，它写 1970304）—— 留着会把状态栏时长 3:41 撑成 33:40；
  //   (2) 力度就是 note-on 的力度字节（不是别的换算），快照里 99 档。
  let midiRan = 0;
  if (existsSync(midiFixture)) {
    step(`MIDI 快照（${midiFixture.split(/[\\/]/).pop()}）`);
    copyFileSync(midiFixture, live);
    await evalJs(`location.reload()`);
    await sleep(2000);

    const midiChecks = [
      ['MIDI 元信息（宿主 midi / SMF 1 / Spring Mpnody / 136 BPM / 4/4 / 44100 / ppq=480）', async () => {
        const t = await evalJs(`(() => {
          const m = window.dawview.state.project.meta;
          return { text: document.getElementById('proj-info').textContent, ppq: m.ppq,
                   host: m.host, version: m.hostVersion };
        })()`);
        return { pass: t.host === 'midi' && t.version === 'SMF 1' && t.ppq === 480
                      && /Spring Mpnody/.test(t.text) && /136 BPM/.test(t.text)
                      && /4\/4/.test(t.text) && /44100/.test(t.text),
                 detail: JSON.stringify(t) };
      }],

      ['MIDI 轨道映射：一条 MTrk = 一条轨 + 整轨一个片段（快照 3 轨 3 片段 2491 音符）', async () => {
        const d = await evalJs(`(() => {
          const s = window.dawview.state.project;
          const kinds = {};
          let notes = 0;
          for (const t of s.tracks) {
            kinds[t.kind] = (kinds[t.kind] || 0) + 1;
            for (const c of t.clips) notes += (c.notes || []).length;
          }
          return { tracks: s.tracks.length, kinds,
                   spans: s.tracks.map((t) => t.clips.map((c) => [c.name === t.name,
                                                                   c.startTick, c.lengthTick])),
                   notes };
        })()`);
        const flat = d.spans.flat();
        return { pass: d.tracks === 3 && d.kinds.midi === 3 && flat.length === 3
                      && flat.every((s) => s[0] === true && s[1] === 0)
                      && d.notes === 2491,
                 detail: JSON.stringify(d) };
      }],

      ['MIDI 每轨音符数与片段长度对上（992 / 1209 / 290；264981 / 259080 / 242400 tick）', async () => {
        const r = await evalJs(`(() => {
          const s = window.dawview.state.project;
          return s.tracks.map((t) => [t.name, t.clips[0].notes.length, t.clips[0].lengthTick]);
        })()`);
        return { pass: JSON.stringify(r) === JSON.stringify([
          ['PianoCloseMic', 992, 264981], ['PianoFarMic', 1209, 259080],
          ['Violins 1', 290, 242400]]),
                 detail: JSON.stringify(r) };
      }],

      ['MIDI 力度取 note-on 的力度字节（快照 99 档；PianoCloseMic 87 档 7..103）', async () => {
        const r = await evalJs(`(() => {
          const s = window.dawview.state.project;
          const all = s.tracks.flatMap((t) => t.clips.flatMap((c) => c.notes.map((n) => n.velocity)));
          const first = s.tracks[0].clips[0].notes.map((n) => n.velocity);
          return { levels: new Set(all).size, firstLevels: new Set(first).size,
                   min: Math.min(...first), max: Math.max(...first) };
        })()`);
        // 塌成一两档那种读法（把别的字节当力度）会在这里露馅
        return { pass: r.levels === 99 && r.firstLevels === 87 && r.min === 7 && r.max === 103,
                 detail: JSON.stringify(r) };
      }],

      ['MIDI 的 CC 进了契约（CC1 调制轮 2779 点 / CC58 17 / CC64 延音踏板 619）', async () => {
        const r = await evalJs(`window.dawview.ccChoices().map((c) => [c.cc, c.name, c.n])`);
        return { pass: JSON.stringify(r) === JSON.stringify([
          [1, '调制轮', 2779], [58, 'CC58', 17], [64, '延音踏板', 619]]),
                 detail: JSON.stringify(r) };
      }],

      ['MIDI 速度轨：214 点，末尾那条超远速度点已丢掉（状态栏时长 3:41，不是 33:40）', async () => {
        const r = await evalJs(`(() => {
          const p = window.dawview.state.project;
          const ticks = p.tempoMap.map((x) => x[0]);
          return { points: p.tempoMap.length, first: p.tempoMap[0][1], last: p.tempoMap.at(-1),
                   maxTick: Math.max(...ticks), lengthTicks: p.lengthTicks,
                   totalSec: window.dawview.state.tempo.totalSec,
                   status: document.getElementById('status-text').textContent };
        })()`);
        // 内容到 264981 tick，MuseScore 却在 1970304 tick 又写了一条速度（120 BPM）：
        // 留着的话 totalSec 会从 221 秒变成 2020 秒（状态栏显示 33:40）
        // 首点 136.0 而不是 136.000145：微秒反算的尾巴按 1e-3 收敛了
        return { pass: r.points === 214 && r.first === 136
                      && JSON.stringify(r.last) === JSON.stringify([243840, 120])
                      && r.maxTick <= r.lengthTicks
                      && Math.abs(r.totalSec - 221.4394) < 0.5
                      && /时长 3:41/.test(r.status),
                 detail: JSON.stringify({ ...r, status: undefined }) };
      }],

      ['钢琴窗：MIDI 的音符画出来了（快照 2491 个，音区 31..98）', async () => {
        const r = await evalJs(`(() => {
          const dv = window.dawview;
          dv.setViewMode('midi');
          dv.state.hiddenTracks.clear();
          dv.state.kindFilter = '';
          dv.rebuildView();
          dv.paint();
          const v = dv.state.view;
          const pitches = v.notes.map((n) => n.pitch);
          return { n: v.notes.length, min: Math.min(...pitches), max: Math.max(...pitches),
                   lo: dv.state.pitchLo, hi: dv.state.pitchHi };
        })()`);
        return { pass: r.n === 2491 && r.min === 31 && r.max === 98,
                 detail: JSON.stringify(r) };
      }],
    ];

    for (const [name, fn] of midiChecks) {
      midiRan++;
      step(name);
      try {
        const r = await fn();
        console.log(`  ${r.pass ? 'PASS' : 'FAIL'} ${r.detail ?? ''}`);
        if (!r.pass) failed++;
      } catch (err) {
        console.log(`  ERROR ${err.message}`);
        failed++;
      }
    }

    await evalJs(`(() => {
      const dv = window.dawview;
      dv.state.lanes = [];
      dv.setViewMode('arrange');
      dv.state.pxPerTick = 0.05;
      dv.state.playheadTick = 0;
      dv.rebuildView();
      document.getElementById('scroll').scrollLeft = 0;
      document.getElementById('scroll').scrollTop = 0;
      dv.paint();
    })()`);
    await sleep(300);
    await shot('shot-midi.png');

    // 钢琴窗也留一张（上面"5346 → 快照 2491 个音符"那条断言就是在这一屏上成立的）
    await evalJs(`(() => {
      const dv = window.dawview;
      dv.setViewMode('midi');
      dv.state.pxPerTick = 0.35;
      dv.state.playheadTick = 0;
      dv.rebuildView();
      dv.paint();
    })()`);
    await sleep(300);
    await shot('shot-midi-piano.png');

    if (existsSync(fixture)) {          // 复原固定快照
      copyFileSync(fixture, live);
      await evalJs(`location.reload()`);
      await sleep(1500);
    }
  }

  const ran = (existsSync(fixture) ? checks.length : 0)
            + (existsSync(flFixture) ? flRan : 0)
            + (existsSync(reaperFixture) ? reaperRan : 0)
            + (existsSync(bitwigFixture) ? bitwigRan : 0)
            + (existsSync(studioOneFixture) ? studioOneRan : 0)
            + (existsSync(midiFixture) ? midiRan : 0)
            + (existsSync(tempoFixture) ? tempoRan : 0);
  if (ran === 0) {
    console.log('\n0 项：没有数据快照，什么都没验证。');
    console.log('生成方法见 README「验证」一节（python scripts/make-fixture.py <工程文件>）。');
    console.log('\nNOTHING VERIFIED');
  } else {
    console.log(failed === 0 ? '\nALL CHECKS PASSED' : `\n${failed} CHECK(S) FAILED`);
  }
  process.exitCode = failed === 0 ? 0 : 1;
} catch (err) {
  console.error('ERROR:', err.message);
  process.exitCode = 1;
} finally {
  ws.close();
}
