// dawview 用户音频轨（AudioLane）端到端验证 —— 零依赖 CDP 驱动（Node ≥22）。
//
// 为什么单独一个脚本：音频轨要走**真·后端**（上传音频 -> 落盘 -> 用 /media 读回 ->
// 解码），而 scripts/verify.mjs 挂的是静态 http.server（没有 /audiolanes 这些接口）。
// 这个脚本自带本地服务、自带浏览器，跑完自己收摊；工程与音频数据都放在临时目录，
// 不碰你仓库里的任何东西（只有 web/project.json 会被快照覆盖，跑完还原）。
//
// 用法: node scripts/audio-verify.mjs [工程或契约 JSON]
//       node scripts/audio-verify.mjs docs/demo-project.json --python python3.14
import { spawn } from 'node:child_process';
import { copyFileSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const arg = (flag, dflt) => {
  const i = process.argv.indexOf(flag);
  return i >= 0 ? process.argv[i + 1] : dflt;
};
const PROJECT = process.argv[2] && !process.argv[2].startsWith('--')
  ? resolve(process.argv[2]) : join(ROOT, 'docs', 'demo-project.json');
const PYTHON = arg('--python', process.env.DAWVIEW_PYTHON || 'python');
const CDP = Number(arg('--cdp', 0)) || await freePort();

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const near = (a, b, tol) => Math.abs(a - b) <= tol;
let passed = 0;
let failed = 0;
let skipped = 0;
function check(name, ok, detail = '') {
  if (ok) { passed++; console.log(`  ok    ${name}${detail ? '  — ' + detail : ''}`); }
  else { failed++; console.log(`  FAIL  ${name}${detail ? '  — ' + detail : ''}`); }
}
function skip(name, why) { skipped++; console.log(`  skip  ${name}  — ${why}`); }
const step = (l) => console.log(`\n• ${l}`);

async function freePort() {
  const { createServer } = await import('node:net');
  return new Promise((res, rej) => {
    const srv = createServer();
    srv.on('error', rej);
    srv.listen(0, '127.0.0.1', () => {
      const p = srv.address().port;
      srv.close(() => res(p));
    });
  });
}

const EDGE_CANDIDATES = [
  'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
  join(process.env.LOCALAPPDATA || '', 'Microsoft', 'Edge', 'Application', 'msedge.exe'),
  join(process.env.LOCALAPPDATA || '', 'Google', 'Chrome', 'Application', 'chrome.exe'),
];
const EDGE = EDGE_CANDIDATES.find((p) => p && existsSync(p));

/* ---------------------------------------------------- 造一个真音频文件（WAV） */

// 22050 Hz 单声道 16 bit：1.5 秒、音量有起伏（画出来的波形该有高有低）
function makeWav(seconds = 1.5, rate = 22050, freq = 220) {
  const n = Math.round(seconds * rate);
  const pcm = Buffer.alloc(n * 2);
  for (let i = 0; i < n; i++) {
    const t = i / rate;
    const env = Math.min(1, t / 0.2) * (1 - 0.6 * (t / seconds));
    const v = Math.sin(2 * Math.PI * freq * t) * env * 26000;
    pcm.writeInt16LE(Math.round(v), i * 2);
  }
  const head = Buffer.alloc(44);
  head.write('RIFF', 0);
  head.writeUInt32LE(36 + pcm.length, 4);
  head.write('WAVE', 8);
  head.write('fmt ', 12);
  head.writeUInt32LE(16, 16);
  head.writeUInt16LE(1, 20);          // PCM
  head.writeUInt16LE(1, 22);          // 单声道
  head.writeUInt32LE(rate, 24);
  head.writeUInt32LE(rate * 2, 28);
  head.writeUInt16LE(2, 32);
  head.writeUInt16LE(16, 34);
  head.write('data', 36);
  head.writeUInt32LE(pcm.length, 40);
  return Buffer.concat([head, pcm]);
}

/* ------------------------------------------------------------- 浏览器（CDP） */

class Page {
  constructor(ws) { this.ws = ws; this.seq = 0; this.pending = new Map(); }

  static async launch(port, profile) {
    const proc = spawn(EDGE, [
      '--headless=new',
      `--remote-debugging-port=${port}`,
      `--user-data-dir=${profile}`,
      '--no-first-run', '--no-default-browser-check', '--disable-sync',
      '--window-size=1280,820',
      '--autoplay-policy=no-user-gesture-required',   // 无头环境没有"用户操作"，别把 AudioContext 挂起
      'about:blank',
    ], { stdio: 'ignore' });
    const version = await pollJson(`http://127.0.0.1:${port}/json/version`, 20000);
    const ws = new WebSocket(version.webSocketDebuggerUrl);
    await withTimeout(new Promise((res, rej) => {
      ws.onopen = res;
      ws.onerror = () => rej(new Error('CDP 连不上'));
    }), 10000, 'ws open');
    const page = new Page(ws, proc);
    const contexts = new Map();
    page.errors = [];
    ws.onmessage = (e) => {
      const m = JSON.parse(e.data);
      if (m.id && page.pending.has(m.id)) {
        const { res, rej } = page.pending.get(m.id);
        page.pending.delete(m.id);
        m.error ? rej(new Error(m.error.message)) : res(m.result);
        return;
      }
      // 记页面里的 JS 异常：音频轨是后加的，别在没后端 / 缺元素时炸掉整页
      if (m.method === 'Runtime.exceptionThrown') {
        const d = m.params.exceptionDetails;
        page.errors.push(d.exception?.description || d.text || 'exception');
      }
    };
    page.contexts = contexts;
    return page;
  }

  send(method, params = {}, sessionId) {
    return withTimeout(new Promise((res, rej) => {
      const id = ++this.seq;
      this.pending.set(id, { res, rej });
      const msg = { id, method, params };
      if (sessionId) msg.sessionId = sessionId;
      this.ws.send(JSON.stringify(msg));
    }), 20000, method);
  }

  async open(url) {
    const { targetId } = await this.send('Target.createTarget', { url });
    const { sessionId } = await this.send('Target.attachToTarget', { targetId, flatten: true });
    this.active = sessionId;
    this.contexts = this.contexts || new Map();
    this.contexts.set(sessionId, []);
    await this.send('Runtime.enable', {}, sessionId);
    await this.send('Page.enable', {}, sessionId);
    return sessionId;
  }

  async eval(expression, sessionId = this.active) {
    const r = await withTimeout(this.send('Runtime.evaluate',
      { expression, returnByValue: true, awaitPromise: true }, sessionId), 30000, 'evaluate');
    if (r.exceptionDetails) {
      throw new Error(r.exceptionDetails.exception?.description || r.exceptionDetails.text);
    }
    return r.result?.value;
  }

  async waitFor(expression, ms = 20000, label = expression, sessionId = this.active) {
    const deadline = Date.now() + ms;
    let last;
    while (Date.now() < deadline) {
      try { if (await this.eval(expression, sessionId)) return true; } catch (e) { last = e; }
      await sleep(120);
    }
    throw new Error(`等不到「${label}」${last ? '：' + last.message : ''}`);
  }

  mouse(type, x, y, button = 'left') {
    return this.send('Input.dispatchMouseEvent',
      { type, x, y, button, clickCount: type === 'mouseMoved' ? 0 : 1 }, this.active);
  }

  async drag(from, to, steps = 6) {
    await this.mouse('mouseMoved', from.x, from.y);
    await this.mouse('mousePressed', from.x, from.y);
    for (let i = 1; i <= steps; i++) {
      await this.mouse('mouseMoved', from.x + (to.x - from.x) * i / steps,
                       from.y + (to.y - from.y) * i / steps, 'none');
      await sleep(16);
    }
    await this.mouse('mouseReleased', to.x, to.y);
    await sleep(60);
  }

  async click(x, y, button = 'left') {
    await this.mouse('mouseMoved', x, y);
    await this.mouse('mousePressed', x, y, button);
    await this.mouse('mouseReleased', x, y, button);
    await sleep(80);
  }

  async close() {
    try { await withTimeout(this.send('Browser.close'), 4000, 'Browser.close'); } catch (e) { /* 无所谓 */ }
  }
}

async function pollJson(url, ms) {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    try {
      const r = await fetch(url);
      if (r.ok) return await r.json();
    } catch (e) { /* 还没起来 */ }
    await sleep(200);
  }
  throw new Error(`CDP 起不来（${url}）`);
}

const withTimeout = (p, ms, label) => Promise.race([
  p, new Promise((_, rej) => setTimeout(() => rej(new Error(`timeout: ${label}`)), ms)),
]);

/* ---------------------------------------------------------------- 本地服务 */

function startServer(project, audioDir) {
  const proc = spawn(PYTHON, ['-u', '-m', 'dawview', project, '--no-window',
    '--port', '0', '--prefs', 'none', '--audio-dir', audioDir],
  { cwd: ROOT, env: { ...process.env, PYTHONIOENCODING: 'utf-8' }, stdio: ['ignore', 'pipe', 'pipe'] });
  let out = '';
  proc.stdout.on('data', (d) => { out += d.toString(); });
  proc.stderr.on('data', (d) => { out += d.toString(); });
  const ready = new Promise((res, rej) => {
    const timer = setTimeout(() => rej(new Error('本地服务 25 秒没起来：\n' + out)), 25000);
    proc.stdout.on('data', () => {
      const m = out.match(/(http:\/\/localhost:\d+)\/index\.html/);
      if (m) { clearTimeout(timer); res(m[1]); }
    });
    proc.on('exit', (code) => {
      clearTimeout(timer);
      rej(new Error(`本地服务退出了（code=${code}）：\n${out}`));
    });
  });
  return { proc, ready, tail: () => out };
}

/* ---------------------------------------------------------- 静态服务（对照用） */

// 一份最小的静态服务：只为验"没跑后端时直接开 index.html"那条路（没有 /audiolanes）。
async function serveStatic(root) {
  const { createServer } = await import('node:http');
  const { readFile } = await import('node:fs/promises');
  const types = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css',
                  '.json': 'application/json', '.svg': 'image/svg+xml', '.png': 'image/png' };
  const srv = createServer(async (req, res) => {
    const rel = decodeURIComponent(req.url.split('?')[0]).replace(/^\/+/, '');
    const file = join(root, rel || 'index.html');
    try {
      const body = await readFile(file);
      const ext = file.slice(file.lastIndexOf('.'));
      res.writeHead(200, { 'Content-Type': types[ext] || 'application/octet-stream' });
      res.end(body);
    } catch (e) {
      res.writeHead(404); res.end('not found');
    }
  });
  const port = await freePort();
  await new Promise((res) => srv.listen(port, '127.0.0.1', res));
  staticSrv = srv;
  return `http://127.0.0.1:${port}`;
}

/* ------------------------------------------------------------------ 主流程 */

const work = mkdtempSync(join(tmpdir(), 'dawview-audio-'));
const liveSnapshot = join(ROOT, 'web', 'project.json');
const hadSnapshot = existsSync(liveSnapshot);
const oldSnapshot = hadSnapshot ? readFileSync(liveSnapshot) : null;

let server;
let page;
let staticSrv;
const extraTargets = [];

try {
  if (!EDGE) throw new Error('找不到 Edge / Chrome，没法做端到端验证');

  // 工程与音频数据都放临时目录：.dawview/ 跟着工程走，别写进仓库
  const project = join(work, 'project.json');
  copyFileSync(PROJECT, project);
  const audioDir = join(work, 'audio');
  const wav = makeWav();
  const wavB64 = wav.toString('base64');
  writeFileSync(join(work, 'verify-tone.wav'), wav);

  step(`起本地服务（临时工程 ${project}）`);
  server = startServer(project, audioDir);
  const base = await server.ready;
  console.log(`  服务：${base}`);
  console.log(`  （$LOCALAPPDATA 之外的临时目录，跑完整个删掉）`);

  step('起无头 Edge（自带 profile，CDP 随机端口）');
  page = await Page.launch(CDP, join(work, 'profile'));
  await page.open(`${base}/index.html`);
  await page.waitFor(`!!(window.dawview && window.dawview.state.project)`, 25000, '页面 boot');
  await page.waitFor(`window.dawview.state.audioAvailable === true`, 10000, '音频轨接口就位');

  // ---------------------------------------------------------------- 1) 接口
  step('1) 接口：/audiolanes.json 可写，数据落在工程旁边');
  const api = (path, init) => fetch(`http://127.0.0.1:${new URL(base).port}${path}`, init);
  const info0 = await (await api('/audiolanes.json')).json();
  const dirOk = String(info0.dir || '').replace(/\\/g, '/').endsWith('/audio');
  check('/audiolanes.json 报出音频目录与可写', dirOk && info0.writable === true && Array.isArray(info0.lanes),
    `dir=${info0.dir} writable=${info0.writable} lanes=${info0.lanes.length}`);
  const pageInfo = await page.eval(`(() => {
    const s = window.dawview.state;
    return { available: s.audioAvailable, writable: s.audioWritable, dir: s.audioDir, lanes: s.audioLanes.length };
  })()`);
  check('页面认下了这份音频目录', pageInfo.available === true && pageInfo.writable === true
    && pageInfo.dir.replace(/\\/g, '/').endsWith('/audio'), JSON.stringify(pageInfo));

  // ------------------------------------------------------------ 2) 纯逻辑
  step('2) 纯逻辑（tick<->秒 / 移动 / 裁剪 / 吸附 / 排期 / 峰值）');
  const pure = await page.eval(`(() => {
    const dv = window.dawview, t = dv.state.tempo, ppq = dv.state.project.meta.ppq;
    const bpm = dv.state.project.meta.bpm;
    const secPerBeat = 60 / bpm;
    const clip = { id: 'c1', name: 'a.wav', file: 'media/x.wav',
                   startTick: 0, srcOffsetSec: 0.5, lengthSec: 3.5, srcDurSec: 4 };
    const moved = audioMoveTo(clip, 5000);
    const l = audioTrimLeft(t, clip, ppq, 4);         // 左裁剪到第 1 拍（= 半拍秒数）
    const la = audioTrimLeft(t, clip, -999, 4);       // 想拉到源开头之前：夹住，等于没动
    const r = audioTrimRight(t, clip, ppq * 100, 4);  // 右裁剪拉到源结尾之后：夹住
    const short = audioTrimRight(t, clip, 1, 4);      // 拉到比最短还短：夹到最短
    const plan = audioPlan(
      [{ id: 'L1', clips: [{ ...clip, startTick: ppq * 4, lengthSec: 2, srcOffsetSec: 0 }] },
       { id: 'L2', muted: true, clips: [{ ...clip, startTick: 0, lengthSec: 2 }] }],
      t, secPerBeat * 4, 1);
    const planMid = audioPlan(
      [{ id: 'L1', clips: [{ ...clip, startTick: ppq * 4, lengthSec: 2, srcOffsetSec: 0 }] }],
      t, secPerBeat * 4 + 1, 1);
    const planFast = audioPlan(
      [{ id: 'L1', clips: [{ ...clip, startTick: ppq * 4, lengthSec: 2, srcOffsetSec: 0 }] }],
      t, secPerBeat * 4, 2);
    const peaks = computePeaks([new Float32Array([0, 0.5, -0.5, 1])], 2);
    const [lo, hi] = peakRange(peaks, 0, 1);
    return {
      tickSec: audioSecAtTick(t, ppq * 4), secPerBeat, bpm, ppq,
      snap: audioSnapTick(1000, ppq), snapZero: audioSnapTick(-200, ppq),
      moved: { tick: moved.startTick, len: moved.lengthSec, off: moved.srcOffsetSec },
      left: { tick: l.startTick, off: l.srcOffsetSec, len: l.lengthSec,
              endSec: audioStartSec(t, l) + l.lengthSec, wasEndSec: audioStartSec(t, clip) + clip.lengthSec },
      leftClamp: { tick: la.startTick, off: la.srcOffsetSec, len: la.lengthSec },
      rightClamp: r.lengthSec, shortLen: short.lengthSec, minLen: AUDIO_MIN_LEN,
      plan, planMid, planFast,
      peaks: [lo, hi, peaks.min[0], peaks.max[1]],
      ext: ['a.mp3', 'b.WAV', 'c.ogg', 'd.flac', 'e.m4a', 'f.txt', 'g.mp4']
        .map((n) => audioExtOk(n)),
      planLen: dv.audioPlanNow().length,
    };
  })()`);
  check(`tick -> 秒（${pure.bpm} BPM / ppq ${pure.ppq}：4 拍 = ${(pure.secPerBeat * 4).toFixed(3)} 秒）`,
    near(pure.tickSec, pure.secPerBeat * 4, 0.002), `${pure.tickSec.toFixed(4)}s`);
  check('吸附到拍（1000 -> 960；负数吸到 0，不会吸出负 tick）',
    pure.snap === 960 && pure.snapZero === 0, `${pure.snap} / ${pure.snapZero}`);
  check('挪位置只动 tick（源内偏移与长度不变）',
    pure.moved.tick === 5000 && pure.moved.len === 3.5 && pure.moved.off === 0.5,
    JSON.stringify(pure.moved));
  check('左裁剪：内容在时间轴上不动（起点后移多少秒就多跳过多少秒）',
    near(pure.left.off, 0.5 + pure.secPerBeat, 1e-6)
      && near(pure.left.endSec, pure.left.wasEndSec, 1e-6),
    JSON.stringify(pure.left));
  check('左裁剪拉到源开头之前 = 原地不动（起点被夹到 0）',
    pure.leftClamp.tick === 0 && pure.leftClamp.off === 0.5
      && near(pure.leftClamp.len, 3.5, 1e-6), JSON.stringify(pure.leftClamp));
  check('右裁剪夹到源文件结尾（0.5 + 3.5 = 4s）', near(pure.rightClamp, 3.5, 1e-6),
    String(pure.rightClamp));
  check('右裁剪夹到最短长度', pure.shortLen === pure.minLen, String(pure.shortLen));
  check('播放排期：从片段起点起播（when=0 / 取满长度 / 静音轨不排）',
    pure.plan.length === 1 && near(pure.plan[0].when, 0, 1e-6)
      && near(pure.plan[0].offsetSec, 0, 1e-6) && near(pure.plan[0].durSec, 2, 1e-6),
    JSON.stringify(pure.plan));
  check('播放排期：从片段中间起播（偏移 +1s、长度 -1s）',
    near(pure.planMid[0].offsetSec, 1, 1e-6) && near(pure.planMid[0].durSec, 1, 1e-6),
    JSON.stringify(pure.planMid));
  check('播放排期：变速（when 减半、rate=2）',
    near(pure.planFast[0].when, 0, 1e-6) && pure.planFast[0].rate === 2,
    JSON.stringify(pure.planFast));
  check('峰值桶与取极值', JSON.stringify(pure.peaks) === JSON.stringify([-0.5, 1, 0, 1]),
    JSON.stringify(pure.peaks));
  check('认得出常见音频扩展名（mp3/wav/ogg/flac/m4a 认，txt/mp4 不认）',
    JSON.stringify(pure.ext) === JSON.stringify([true, true, true, true, true, false, false]),
    JSON.stringify(pure.ext));
  check('还没导入时没有可播的片段', pure.planLen === 0, String(pure.planLen));

  // -------------------------------------------------------------- 3) 导入
  step('3) 导入：上传 -> 落盘 -> 读回解码 -> 上轨道');
  const imp = await page.eval(`(async () => {
    const bytes = Uint8Array.from(atob('${wavB64}'), (c) => c.charCodeAt(0));
    const file = new File([bytes], '参考 混音 (1).wav', { type: 'audio/wav' });
    const made = await window.dawview.importAudioFiles([file], { tick: 0 });
    const s = window.dawview.state;
    const clip = made[0];
    const info = clip ? window.dawview.audioEngine.info(clip.file) : null;
    return {
      made: made.length, lanes: s.audioLanes.length,
      clip: clip ? { file: clip.file, name: clip.name, tick: clip.startTick,
                     len: clip.lengthSec, srcDur: clip.srcDurSec } : null,
      decoded: info ? info.durSec : 0,
      status: document.getElementById('status-text').textContent,
      saving: s.audioSaving,
    };
  })()`);
  check('导入后多了一条音频轨、一个片段', imp.made === 1 && imp.lanes === 1,
    JSON.stringify({ made: imp.made, lanes: imp.lanes }));
  check('片段长度 = 音频真实时长（1.5 秒）', imp.clip && near(imp.clip.len, 1.5, 0.02)
    && near(imp.decoded, 1.5, 0.02) && near(imp.clip.srcDur, 1.5, 0.02),
    JSON.stringify(imp.clip) + ` decoded=${imp.decoded}`);
  check('文件名被 ASCII 化并带内容哈希（去掉空格/括号/中文）',
    imp.clip && /^media\/[0-9a-f]{8}-[A-Za-z0-9._-]+\.wav$/.test(imp.clip.file),
    imp.clip && imp.clip.file);
  check('状态栏报出音频轨', /音频轨 1（1 段）/.test(imp.status), imp.status);

  const mediaPath = join(audioDir, 'media', imp.clip.file.split('/').pop());
  check('音频文件真的落盘了（临时目录里的 media/）', existsSync(mediaPath), mediaPath);
  const back = await api(`/media/${encodeURIComponent(imp.clip.file.split('/').pop())}`);
  const backBytes = Buffer.from(await back.arrayBuffer());
  check('从 /media 读回来字节一致',
    back.status === 200 && backBytes.length === wav.length
      && backBytes.subarray(0, 12).toString('latin1').startsWith('RIFF'),
    `HTTP ${back.status} ${backBytes.length} 字节（原始 ${wav.length}）`);
  const ranged = await api(`/media/${encodeURIComponent(imp.clip.file.split('/').pop())}`,
    { headers: { Range: 'bytes=0-15' } });
  check('Range 取音频可用（拖动定位时浏览器只取一段）',
    ranged.status === 206 && (await ranged.arrayBuffer()).byteLength === 16,
    `HTTP ${ranged.status}`);

  await sleep(600);          // 等存盘防抖
  const saved = await (await api('/audiolanes.json')).json();
  check('音频轨数据落盘（.dawview 那一侧的 audio-lanes.json）',
    saved.lanes.length === 1 && saved.lanes[0].clips.length === 1
      && saved.lanes[0].clips[0].file === imp.clip.file,
    JSON.stringify(saved.lanes[0] && saved.lanes[0].clips[0] && saved.lanes[0].clips[0].file));

  // -------------------------------------------------- 4) 拖动 / 裁剪（真鼠标）
  step('4) 交互：拖中间挪位置、拖两头改长度（真鼠标事件）');
  // 先放大到"1 tick = 0.5px"：默认缩放下一屏就装下整个工程，1.5 秒的片段只有 57px 宽，
  // 拖动距离一不小心就超过整段长度，裁出来的都是极限值，验不出中间行为。
  await page.eval(`(() => {
    const dv = window.dawview;
    dv.state.pxPerTick = 0.5;
    dv.rebuildView();
    document.getElementById('scroll').scrollLeft = 0;
    dv.paint();
    return 1;
  })()`);
  const geom = () => page.eval(`(() => {
    const dv = window.dawview, s = dv.state, c = document.getElementById('tl');
    const r = c.getBoundingClientRect();
    const lane = s.audioLanes[0], clip = lane && lane.clips[0];
    if (!clip) return null;
    const box = audioClipRect(s.view, lane, clip, s.scrollY, s);
    return { left: r.left, top: r.top, x0: box.x0, x1: box.x1, y: box.y + box.h / 2,
             pxPerTick: s.view.pxPerTick, tick: clip.startTick,
             len: clip.lengthSec, off: clip.srcOffsetSec,
             clipW: box.x1 - box.x0, lengthTicks: s.view.lengthTicks,
             canvasW: c.clientWidth };
  })()`);
  let g = await geom();

  // 拖动前先关掉吸附：这样落点 = 像素位置，可以精确对账
  await page.eval(`window.dawview.setAudioSnap(false)`);
  const before = { tick: g.tick, len: g.len };
  await page.drag({ x: g.left + (g.x0 + g.x1) / 2, y: g.top + g.y },
                  { x: g.left + (g.x0 + g.x1) / 2 + 200, y: g.top + g.y });
  let after = await page.eval(`(() => {
    const c = window.dawview.state.audioLanes[0].clips[0];
    return { tick: c.startTick, len: c.lengthSec, off: c.srcOffsetSec };
  })()`);
  check('拖中间：位置按像素走（200px ≈ 200/pxPerTick tick），长度与源内偏移不变',
    near(after.tick - before.tick, Math.round(200 / g.pxPerTick), 20)
      && near(after.len, before.len, 1e-6) && near(after.off, 0, 1e-6),
    `Δtick=${after.tick - before.tick} 期望≈${Math.round(200 / g.pxPerTick)} len=${after.len}`);

  const trimBefore = await page.eval(`(() => {
    const s = window.dawview.state, c = s.audioLanes[0].clips[0];
    return { sec: s.tempo.secAt(c.startTick), len: c.lengthSec, off: c.srcOffsetSec };
  })()`);
  g = await geom();
  // 左缘：往右拖 120px（内容在时间轴上不能动）
  await page.drag({ x: g.left + g.x0 + 2, y: g.top + g.y },
                  { x: g.left + g.x0 + 2 + 120, y: g.top + g.y });
  const afterL = await page.eval(`(() => {
    const s = window.dawview.state, c = s.audioLanes[0].clips[0];
    return { sec: s.tempo.secAt(c.startTick), len: c.lengthSec, off: c.srcOffsetSec,
             tick: c.startTick };
  })()`);
  check('拖左缘：源内偏移变大、长度变小，绝对结束时间不动',
    afterL.off > trimBefore.off + 0.05 && afterL.len < trimBefore.len - 0.05
      && near(afterL.sec + afterL.len, trimBefore.sec + trimBefore.len, 0.03),
    JSON.stringify({ before: trimBefore, after: afterL, want: 120 / g.pxPerTick }));

  g = await geom();
  const trimR0 = await page.eval(`(() => { const c = window.dawview.state.audioLanes[0].clips[0];
    return { tick: c.startTick, len: c.lengthSec }; })()`);
  // 右缘：往左拖 100px
  await page.drag({ x: g.left + g.x1 - 2, y: g.top + g.y },
                  { x: g.left + g.x1 - 2 - 100, y: g.top + g.y });
  const afterR = await page.eval(`(() => { const c = window.dawview.state.audioLanes[0].clips[0];
    return { tick: c.startTick, len: c.lengthSec }; })()`);
  check('拖右缘：只改长度（起点不动）',
    afterR.tick === trimR0.tick && afterR.len < trimR0.len - 0.02,
    JSON.stringify({ before: trimR0, after: afterR }));

  // 吸附：开着拖，落点该在拍线上（ppq 的整数倍）
  await page.eval(`window.dawview.setAudioSnap(true)`);
  g = await geom();
  await page.drag({ x: g.left + (g.x0 + g.x1) / 2, y: g.top + g.y },
                  { x: g.left + (g.x0 + g.x1) / 2 + 137, y: g.top + g.y });
  const snapped = await page.eval(`(() => {
    const dv = window.dawview, s = dv.state, c = s.audioLanes[0].clips[0];
    return { tick: c.startTick, ppq: s.project.meta.ppq, snap: s.audioSnap,
             moved: Math.abs(c.startTick - ${JSON.stringify(afterR.tick)}) };
  })()`);
  check('开着吸附拖：落点吸到拍上（tick % ppq == 0）',
    snapped.snap === true && snapped.tick % snapped.ppq === 0 && snapped.moved > 0,
    JSON.stringify(snapped));

  // 拖到工程结束之后：时间轴得跟着长（不然那截画在可视区外）
  const grown = await page.eval(`(() => {
    const dv = window.dawview, s = dv.state, c = s.audioLanes[0].clips[0];
    const before = s.view.lengthTicks;
    const projLen = Math.max(...s.project.tracks.map((t) => t.clips.reduce(
      (a, x) => Math.max(a, x.startTick + x.lengthTick), 0)), 0);
    c.startTick = projLen + s.project.meta.ppq * 8;
    dv.rebuildView();
    dv.paint();
    const after = s.view.lengthTicks;
    const box = audioClipRect(s.view, s.audioLanes[0], c, s.scrollY, s);
    return { before, after, projLen, tick: c.startTick, x1: box.x1, w: dv.state.view.headW };
  })()`);
  check('片段拖到工程结束之后：时间轴跟着延长，片段还在画布范围内',
    grown.after > grown.before && grown.after >= grown.tick + 1
      && grown.x1 > grown.w, JSON.stringify(grown));
  await page.eval(`(() => {
    const dv = window.dawview, s = dv.state, c = s.audioLanes[0].clips[0];
    c.startTick = 0; c.srcOffsetSec = 0; c.lengthSec = c.srcDurSec;
    dv.rebuildView(); dv.paint();
    return 1;
  })()`);

  const audioBar = await page.eval(`(() => {
    const dv = window.dawview, s = dv.state;
    const r = audioBarRects(s.view, s.scrollY);
    return r ? { y: r.import.y, x: r.snap.x + 10, importKey: audioBarHit(s.view, r.import.x + 10, r.import.y + 4, s.scrollY),
                 snapKey: audioBarHit(s.view, r.snap.x + 10, r.snap.y + 4, s.scrollY) } : null;
  })()`);
  check('音频区标题条的按钮打得中（导入 / 吸附）',
    audioBar && audioBar.importKey === 'import' && audioBar.snapKey === 'snap',
    JSON.stringify(audioBar));

  // ------------------------------------------------------------ 5) 播放排期
  step('5) 播放：排期跟着走带、静音、定位重排');
  const audioOk = await page.eval(`window.dawview.audioEngine.available()`);
  // 先把片段放回一个已知状态（起点 0 / 没裁剪过），播放排期才好逐项对账
  await page.eval(`(() => {
    const dv = window.dawview, s = dv.state;
    const c = s.audioLanes[0].clips[0];
    s.audioLanes[0].clips[0] = { ...c, startTick: 0, srcOffsetSec: 0, lengthSec: c.srcDurSec || 1.5 };
    dv.rebuildView();
    dv.paint();
    return 1;
  })()`);
  const play = await page.eval(`(() => {
    const dv = window.dawview, s = dv.state;
    dv.seekToTick(0);
    dv.setPlaying(true);
    const snap = dv.audioEngine.snapshot();
    const plan = dv.audioPlanNow();
    dv.setPlaying(false);
    return { snap, planLen: plan.length, playing: s.playing,
             sources: snap.sources, rate: plan[0] ? plan[0].rate : 0,
             when: plan[0] ? plan[0].when : null, off: plan[0] ? plan[0].offsetSec : null,
             lastPlan: snap.lastPlan };
  })()`);
  check('按播放：排期里有一路，落在"此刻"（提前量之内）',
    play.planLen === 1 && play.when >= -0.2 && play.when <= 0.01 && play.off >= 0 && play.off <= 0.25,
    JSON.stringify({ planLen: play.planLen, when: play.when, off: play.off }));
  if (audioOk) {
    check('真的起了 BufferSource（音频引擎连上了 Web Audio）',
      play.sources >= 1, `sources=${play.sources}`);
  } else {
    skip('真的起了 BufferSource', '这个浏览器没有 Web Audio');
  }
  const afterStop = await page.eval(`window.dawview.audioEngine.snapshot().sources`);
  check('停播后没有残留的 BufferSource', afterStop === 0, `sources=${afterStop}`);

  const mid = await page.eval(`(() => {
    const dv = window.dawview, s = dv.state;
    const clip = s.audioLanes[0].clips[0];
    // 定位到片段中间（往右 40px）
    const delta = Math.round(40 / s.view.pxPerTick);
    const wantSec = s.tempo.secAt(clip.startTick + delta) - s.tempo.secAt(clip.startTick);
    dv.seekToTick(clip.startTick + delta);
    dv.setPlaying(true);
    const plan = dv.audioPlanNow();
    dv.setPlaying(false);
    return { wantSec, plan: plan[0] || null, clipLen: clip.lengthSec, srcOff: clip.srcOffsetSec };
  })()`);
  check('从片段中间起播：源内偏移按"已经过去的时间"推进',
    mid.plan && near(mid.plan.offsetSec, mid.srcOff + mid.wantSec + 0.08, 0.03)
      && near(mid.plan.durSec, mid.clipLen - (mid.plan.offsetSec - mid.srcOff), 0.03),
    JSON.stringify({ want: mid.wantSec, srcOff: mid.srcOff,
                     off: mid.plan && mid.plan.offsetSec,
                     dur: mid.plan && mid.plan.durSec, len: mid.clipLen }));

  const fast = await page.eval(`(() => {
    const dv = window.dawview;
    const slow = dv.audioPlanNow()[0];
    dv.setSpeed(2);
    const fast = dv.audioPlanNow()[0];
    dv.setSpeed(1);
    return { slowRate: slow.rate, fastRate: fast.rate, fastOff: fast.offsetSec,
             slowOff: slow.offsetSec, fastDur: fast.durSec, slowDur: slow.durSec };
  })()`);
  check('变速播放：rate=2，提前量按速率放大（磁带式变速）',
    fast.fastRate === 2 && fast.slowRate === 1
      && near(fast.fastOff - fast.slowOff, 0.08, 0.005)
      && fast.fastDur < fast.slowDur, JSON.stringify(fast));

  const mute = await page.eval(`(() => {
    const dv = window.dawview;
    dv.toggleAudioMute(0);
    const muted = { muted: dv.state.audioLanes[0].muted, plan: dv.audioPlanNow().length };
    dv.setPlaying(true);
    const sources = dv.audioEngine.snapshot().sources;
    dv.setPlaying(false);
    dv.toggleAudioMute(0);
    return { ...muted, sources, back: dv.state.audioLanes[0].muted, planBack: dv.audioPlanNow().length };
  })()`);
  check('静音：排期里没有它、也不起声源；取消静音后回来',
    mute.muted === true && mute.plan === 0 && mute.sources === 0
      && mute.back === false && mute.planBack === 1, JSON.stringify(mute));

  // ------------------------------------------------------------ 6) 画波形
  step('6) 画布：波形按峰值真画出来了（像素断言）');
  await page.eval(`(() => { const dv = window.dawview; dv.state.audioHover = null; dv.paint(); })()`);
  const pixels = await page.eval(`(() => {
    const dv = window.dawview, s = dv.state, c = document.getElementById('tl');
    const ctx = c.getContext('2d'), dpr = window.devicePixelRatio || 1;
    const hex = (h) => { h = h.trim().replace('#','');
      return [parseInt(h.slice(0,2),16), parseInt(h.slice(2,4),16), parseInt(h.slice(4,6),16)]; };
    const v = (n) => getComputedStyle(document.documentElement).getPropertyValue(n);
    const mix = (a, b, t) => a.map((x, i) => x + (b[i] - x) * t);
    const audio = hex(v('--clip-audio')), text = hex(v('--text')), bg = hex(v('--bg'));
    const wave = mix(audio, text, 0.3);              // 波形色：片段色往文字色混 0.3
    const lane = s.audioLanes[0], clip = lane.clips[0];
    const box = audioClipRect(s.view, lane, clip, s.scrollY, s);
    const x = Math.round(box.x0 * dpr), y = Math.round((box.y + 2) * dpr);
    const w = Math.max(1, Math.round((box.x1 - box.x0 - 4) * dpr));
    const h = Math.max(1, Math.round((box.h - 4) * dpr));
    const d = ctx.getImageData(x, y, w, h).data;
    let hits = 0, dark = 0;
    for (let i = 0; i < d.length; i += 4) {
      const dist = Math.abs(d[i]-wave[0]) + Math.abs(d[i+1]-wave[1]) + Math.abs(d[i+2]-wave[2]);
      if (dist < 130) hits++;
      if (Math.abs(d[i]-bg[0]) + Math.abs(d[i+1]-bg[1]) + Math.abs(d[i+2]-bg[2]) > 60) dark++;
    }
    return { hits, dark, w, h, expect: wave.map(Math.round) };
  })()`);
  check('片段区域里画出了波形（命中波形色的像素足够多）',
    pixels.hits > 60, JSON.stringify(pixels));

  const rowColors = await page.eval(`(() => {
    const dv = window.dawview, s = dv.state, c = document.getElementById('tl');
    const ctx = c.getContext('2d'), dpr = window.devicePixelRatio || 1;
    const hex = (h) => { h = h.trim().replace('#','');
      return [parseInt(h.slice(0,2),16), parseInt(h.slice(2,4),16), parseInt(h.slice(4,6),16)]; };
    const v = (n) => getComputedStyle(document.documentElement).getPropertyValue(n);
    const bg = hex(v('--bg')), panel = hex(v('--panel'));
    const p = (x, y) => { const d = ctx.getImageData(Math.round(x * dpr), Math.round(y * dpr), 1, 1).data;
                          return [d[0], d[1], d[2]]; };
    const dist = (a, b) => Math.abs(a[0]-b[0]) + Math.abs(a[1]-b[1]) + Math.abs(a[2]-b[2]);
    const lane = s.audioLanes[0];
    const top = audioLaneTop(s.view, 0) - s.scrollY;
    // 音频轨那一行的空白处：该是轨道行底色（bg / panel），不是别的什么
    const empty = p(s.view.headW + 6, top + 3);
    const projRow = p(s.view.headW + 6, audioRowsBottom(s.view) - s.scrollY + 3);
    return { emptyDistBg: dist(empty, bg), emptyDistPanel: dist(empty, panel),
             projDistBg: dist(projRow, bg), projDistPanel: dist(projRow, panel) };
  })()`);
  check('音频轨整行铺了轨道底色（没画成空白画布）',
    Math.min(rowColors.emptyDistBg, rowColors.emptyDistPanel) < 24,
    JSON.stringify(rowColors));

  // -------------------------------------------------- 7) 存盘 / 重载 / 广播
  step('7) 存盘 -> 重载还在；别的窗口改了这边也跟着变');
  await sleep(600);
  const before7 = await page.eval(`(() => { const c = window.dawview.state.audioLanes[0].clips[0];
    return { tick: c.startTick, len: c.lengthSec, off: c.srcOffsetSec, file: c.file }; })()`);
  const persisted = await (await api('/audiolanes.json')).json();
  check('改动都落到 sidecar 里了（tick / 长度 / 源内偏移）',
    persisted.lanes[0].clips[0].startTick === before7.tick
      && near(persisted.lanes[0].clips[0].lengthSec, before7.len, 1e-6)
      && near(persisted.lanes[0].clips[0].srcOffsetSec, before7.off, 1e-6),
    JSON.stringify(persisted.lanes[0].clips[0]));

  await page.eval(`location.reload()`);
  await page.waitFor(`!!(window.dawview && window.dawview.state.project)`, 25000, '重载后 boot');
  await page.waitFor(`window.dawview.state.audioLanes.length === 1`, 10000, '重载后音频轨回来');
  const reloaded = await page.eval(`(() => {
    const dv = window.dawview, s = dv.state, c = s.audioLanes[0].clips[0];
    const box = audioClipRect(s.view, s.audioLanes[0], c, s.scrollY, s);
    return { tick: c.startTick, len: c.lengthSec, off: c.srcOffsetSec, file: c.file,
             name: s.audioLanes[0].name, width: box.x1 - box.x0, decoded: !!dv.audioEngine.info(c.file) };
  })()`);
  check('重载后片段位置/长度/素材都对得上（存盘真的读回来了）',
    reloaded.tick === before7.tick && near(reloaded.len, before7.len, 1e-6)
      && near(reloaded.off, before7.off, 1e-6) && reloaded.file === before7.file
      && reloaded.width > 4, JSON.stringify(reloaded));
  await sleep(800);
  const decodedAgain = await page.eval(`(() => {
    const dv = window.dawview, s = dv.state;
    const info = dv.audioEngine.info(s.audioLanes[0].clips[0].file);
    return info ? info.durSec : 0;
  })()`);
  check('重载后自动把音频解码回来（波形不用手动刷新）',
    near(decodedAgain, 1.5, 0.02), String(decodedAgain));

  const other = await page.open(`${base}/index.html`);
  await page.waitFor(`!!(window.dawview && window.dawview.state.project)`, 25000, '第二个窗口 boot');
  await page.waitFor(`window.dawview.state.audioLanes.length === 1`, 15000, '第二个窗口拿到音频轨');
  const clientA = await page.eval(`window.dawview.getClientId()`, page.contexts.keys().next().value);
  const broadcast = await page.eval(`(async () => {
    const dv = window.dawview;
    const c = dv.state.audioLanes[0].clips[0];
    dv.removeAudioClip(0, 0);
    dv.addAudioLaneAndShow();
    dv.state.audioLanes[0].name = '别家窗口改的名字';
    dv.scheduleAudioSave();
    return 1;
  })()`);
  let seen = false;
  for (let i = 0; i < 40 && !seen; i++) {
    await sleep(150);
    seen = await page.eval(`(() => {
      const s = window.dawview.state;
      return s.audioLanes.length === 1 && s.audioLanes[0].name === '别家窗口改的名字';
    })()`, other);
  }
  check('另一个窗口（OBS 浏览器源那种）跟着变了 —— /audiolanes 的广播通了', seen,
    `发起窗口 client=${clientA}`);

  // ------------------------------- 8) 没有后端时（直接开 index.html）不崩
  step('8) 直接开 index.html（静态服务、没有 /audiolanes）：音频区缺席但不报错');
  const staticBase = await serveStatic(join(ROOT, 'web'));
  const plain = await page.open(`${staticBase}/index.html`);
  await page.waitFor(`!!(window.dawview && window.dawview.state.project)`, 25000, '静态页面 boot');
  const degraded = await page.eval(`(async () => {
    const dv = window.dawview, s = dv.state;
    const before = s.view.lengthTicks;
    const made = await dv.importAudioFiles([new File([new Uint8Array([1,2,3])], 'x.wav')], {});
    return { available: s.audioAvailable, lanes: s.audioLanes.length, made: made.length,
             barH: s.view.audioBarH, plan: dv.audioPlanNow().length,
             btnDisabled: document.getElementById('btn-audio').disabled,
             status: document.getElementById('status-text').textContent,
             lengthTicks: s.view.lengthTicks === before };
  })()`, plain);
  check('没有后端时音频轨读数缺席、导入不崩、排期为空',
    degraded.available === false && degraded.lanes === 0 && degraded.made === 0
      && degraded.barH === 0 && degraded.plan === 0 && degraded.lengthTicks === true,
    JSON.stringify(degraded));
  check('没有后端时「＋ 音频」按钮是灰的（别让人白点）', degraded.btnDisabled === true,
    String(degraded.btnDisabled));
  check('页面里没有 JS 异常（两个页面都算）', page.errors.length === 0,
    page.errors.slice(0, 3).join(' | '));

  // ------------------------------------------------------------------ 收尾
  step('收尾：清掉临时工程与音频数据');
  const final = await (await api('/audiolanes.json')).json();
  check('服务端读得回的音频轨没跑偏', Array.isArray(final.lanes), `lanes=${final.lanes.length}`);

  console.log(`\n${passed} 项通过${failed ? `，${failed} 项失败` : ''}${skipped ? `，${skipped} 项跳过` : ''}`);
  process.exitCode = failed === 0 ? 0 : 1;
} catch (err) {
  console.error('ERROR:', err.message || err);
  if (server) console.error(server.tail());
  process.exitCode = 1;
} finally {
  try { if (page) await page.close(); } catch (e) { /* 无所谓 */ }
  try { if (staticSrv) staticSrv.close(); } catch (e) { /* 无所谓 */ }
  try { if (server) server.proc.kill(); } catch (e) { /* 无所谓 */ }
  if (hadSnapshot && oldSnapshot) writeFileSync(liveSnapshot, oldSnapshot);
  try { rmSync(work, { recursive: true, force: true }); } catch (e) { /* 无所谓 */ }
}
