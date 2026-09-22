// 动效可见度探针：量化"有动效 / 无动效"两帧的像素差，定位到底哪些像素被改了。
// 用法: node scripts/fx-probe.mjs
const CDP = 'http://127.0.0.1:9223';
const TARGET = 'http://127.0.0.1:8765/index.html';

const targets = await (await fetch(`${CDP}/json`)).json();
const page = targets.find((t) => t.type === 'page' && !t.url.startsWith('chrome://'));
const ws = new WebSocket(page.webSocketDebuggerUrl);
await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });

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
const send = (method, params = {}) => new Promise((res, rej) => {
  const i = ++id;
  pending.set(i, { res, rej });
  ws.send(JSON.stringify({ id: i, method, params }));
});
const evalJs = async (expression) => {
  const r = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
  if (r.exceptionDetails) throw new Error(r.exceptionDetails.text + ' :: ' + (r.exceptionDetails.exception?.description || ''));
  return r.result?.value;
};

await send('Network.enable');
await send('Network.setCacheDisabled', { cacheDisabled: true });
await send('Page.enable');
await send('Page.navigate', { url: TARGET });
await new Promise((r) => setTimeout(r, 2500));

// 共用：装好画布差分工具
const HARNESS = `
  const dv = window.dawview;
  const c = document.getElementById('tl'), ctx = c.getContext('2d');
  const dpr = window.devicePixelRatio || 1;
  const grab = () => ctx.getImageData(0, 0, c.width, c.height).data;
  const sum = (d) => { let s = 0; for (let i = 0; i < d.length; i += 4) s += d[i] + d[i+1] + d[i+2]; return s; };
  const diff = (a, b) => {
    let brighter = 0, darker = 0, maxUp = 0, maxDown = 0, bbox = [1e9, 1e9, -1, -1], dbox = [1e9, 1e9, -1, -1];
    let worstDown = null;
    for (let i = 0; i < a.length; i += 4) {
      const da = (a[i] + a[i+1] + a[i+2]) - (b[i] + b[i+1] + b[i+2]);
      const px = (i/4) % c.width, py = Math.floor((i/4) / c.width);
      if (da > 3) {
        brighter++;
        if (px < bbox[0]) bbox[0] = px; if (py < bbox[1]) bbox[1] = py;
        if (px > bbox[2]) bbox[2] = px; if (py > bbox[3]) bbox[3] = py;
      } else if (da < -3) {
        darker++;
        if (px < dbox[0]) dbox[0] = px; if (py < dbox[1]) dbox[1] = py;
        if (px > dbox[2]) dbox[2] = px; if (py > dbox[3]) dbox[3] = py;
        if (!worstDown || -da > worstDown.d) {
          worstDown = { d: -da, x: px, y: py, before: [b[i], b[i+1], b[i+2]], after: [a[i], a[i+1], a[i+2]] };
        }
      }
      if (da > maxUp) maxUp = da; if (-da > maxDown) maxDown = -da;
    }
    return { brighter, darker, maxUp, maxDown, bbox, dbox, worstDown };
  };
`;

const r = await evalJs(`(() => {
  ${HARNESS}
  const out = {};

  // --- 配置 A：检查用例同款（playing=false，跨过几个音符）---
  dv.setViewMode('arrange');
  dv.setFx({ on: true, note: true, clip: true, head: true, strength: 1, decay: 420 });
  dv.state.pxPerTick = 0.08; dv.rebuildView();
  const sc = document.getElementById('scroll');
  sc.scrollLeft = 0; sc.scrollTop = 0; sc.dispatchEvent(new Event('scroll'));
  const clip = dv.state.project.tracks.flatMap((t) => t.clips).find((x) => x.kind === 'midi');
  const from = clip.startTick + clip.notes[20].startTick - 30;
  dv.state.playing = false;
  dv.state.hits = [];
  dv.collectHits(from, from + 60);
  dv.state.playheadTick = from;
  dv.paint();
  const A_with = grab();
  const hitsA = dv.state.hits.length;
  dv.state.hits = [];
  dv.paint();
  const A_without = grab();
  out.A = { hits: hitsA, sumWith: sum(A_with), sumWithout: sum(A_without), ...diff(A_with, A_without) };

  // --- 配置 B：截图同款（playing=true，跨过音频片段入点）---
  dv.setFollowMode('center');
  dv.setFx({ strength: 1.4, decay: 700 });
  dv.state.playing = true;
  dv.state.hits = [];
  dv.collectHits(15540, 15640);
  dv.state.playheadTick = 15640;
  dv.followPlayhead();
  dv.paint();
  const B_with = grab();
  dv.state.hits = [];
  dv.paint();
  const B_without = grab();
  out.B = { sumWith: sum(B_with), sumWithout: sum(B_without), ...diff(B_with, B_without) };

  dv.state.playing = false;
  dv.state.hits = [];
  dv.setFx({ strength: 1, decay: 420 });
  dv.setFollowMode('page');
  dv.paint();
  return out;
})()`);
console.log(JSON.stringify(r, null, 2));
ws.close();
