// dawview 多窗口联动验证 —— 零依赖 CDP 驱动（Node ≥22）。
//
// 模拟真实用法：一个 app 窗口（?role=host）+ 一个 OBS 浏览器源（不带参数）。
// 关键点是**两个独立的 Edge 实例、各自的 user-data-dir** —— localStorage 不通用，
// 正是这次要验证的场景（同一个浏览器开两个标签页反而测不出问题）。
// 自带本地服务与浏览器进程，跑完自己收摊；设置写临时文件，不碰 web/prefs.json。
//
// 用法: node scripts/relay-verify.mjs [工程或契约 JSON]
//       node scripts/relay-verify.mjs docs/demo-project.json --python python3.14
import { spawn } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
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
const PORT = Number(arg('--port', process.env.DAWVIEW_TEST_PORT || 8977));
const CDP_A = Number(arg('--cdp-a', 0)) || await freePort();   // "app 窗口"那个实例
const CDP_B = Number(arg('--cdp-b', 0)) || await freePort();   // "OBS 浏览器源"那个实例

// 挑一个空闲端口。写死 9223/9224 的话，机器上正好有个调试实例在跑时，
// 新开的 Edge 起不来但 CDP 端口照样有响应 —— 脚本会一声不吭地连到别人的浏览器上
// （然后失败得莫名其妙）。所以默认随机挑，要固定用 --cdp-a / --cdp-b。
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

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const withTimeout = (p, ms, label) => Promise.race([
  p, new Promise((_, rej) => setTimeout(() => rej(new Error(`timeout: ${label}`)), ms)),
]);
let passed = 0;
let failed = 0;
function check(name, ok, detail = '') {
  if (ok) { passed++; console.log(`  ok    ${name}${detail ? '  — ' + detail : ''}`); }
  else { failed++; console.log(`  FAIL  ${name}${detail ? '  — ' + detail : ''}`); }
}
const step = (l) => console.log(`\n• ${l}`);
const near = (a, b, tol) => Math.abs(a - b) <= tol;

const EDGE_CANDIDATES = [
  'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
  join(process.env.LOCALAPPDATA || '', 'Microsoft', 'Edge', 'Application', 'msedge.exe'),
  join(process.env.LOCALAPPDATA || '', 'Google', 'Chrome', 'Application', 'chrome.exe'),
];
const EDGE = EDGE_CANDIDATES.find((p) => p && existsSync(p));

// 页面状态快照：断言尽量打在这上面，而不是内部的中间变量
const SNAP = `(() => {
  const dv = window.dawview, s = dv.state;
  return {
    theme: getComputedStyle(document.documentElement).getPropertyValue('--bg').trim(),
    themeName: (JSON.parse(localStorage.getItem('dawview.theme') || '{}').name) || '',
    viewMode: s.viewMode, viewModeApplied: s.view.mode,
    playing: s.playing, tick: Math.round(s.playheadTick),
    rowH: Math.round(s.rowH), exportMode: s.exportMode, clean: dv.isClean(),
    hidden: [...s.hiddenTracks].sort((a, b) => a - b),
    colors: Object.entries(s.trackColors).map(([k, v]) => k + ':' + v).join(','),
    clientId: dv.getClientId(), host: dv.isHost(),
    relay: { ...s.relay },
  };
})()`;

// 手动驱动 rAF 队列（无头/后台页面不跑 rAF）
const DRIVE_RAF = (n) => `(() => {
  const cbs = [];
  const orig = window.requestAnimationFrame;
  window.requestAnimationFrame = (cb) => { cbs.push(cb); return cbs.length; };
  const t0 = performance.now();
  for (let i = 0; i < ${n}; i++) { const cb = cbs.shift(); if (cb) cb(t0 + i * 16.7); }
  window.requestAnimationFrame = orig;
  return cbs.length;
})()`;

class Browser {
  constructor(proc, port, label) {
    this.proc = proc;
    this.port = port;
    this.label = label;
    this.pending = new Map();
    this.seq = 0;
    this.errors = [];
  }

  static async launch(port, profile, label) {
    const proc = spawn(EDGE, [
      '--headless=new',
      `--remote-debugging-port=${port}`,
      `--user-data-dir=${profile}`,
      '--no-first-run', '--no-default-browser-check', '--disable-sync',
      '--window-size=1280,820',
      'about:blank',
    ], { stdio: 'ignore' });
    const b = new Browser(proc, port, label);
    await b.connect();
    return b;
  }

  async connect() {
    const info = await this.poll(`http://127.0.0.1:${this.port}/json/version`, 20000);
    this.ws = new WebSocket(info.webSocketDebuggerUrl);
    await withTimeout(new Promise((res, rej) => {
      this.ws.onopen = res;
      this.ws.onerror = () => rej(new Error(`${this.label}: CDP 连不上`));
    }), 10000, 'ws open');
    this.ws.onmessage = (e) => {
      const msg = JSON.parse(e.data);
      if (msg.id && this.pending.has(msg.id)) {
        const { res, rej } = this.pending.get(msg.id);
        this.pending.delete(msg.id);
        msg.error ? rej(new Error(msg.error.message)) : res(msg.result);
        return;
      }
      // 记页面里的 JS 异常与控制台报错（网络 404 之类不算 —— 那些常有噪音）
      if (msg.method === 'Runtime.exceptionThrown') {
        const d = msg.params.exceptionDetails;
        this.errors.push(d.exception?.description || d.text || 'exception');
      } else if (msg.method === 'Log.entryAdded' && msg.params.entry.level === 'error'
                 && msg.params.entry.source === 'javascript') {
        this.errors.push(msg.params.entry.text || 'console error');
      }
    };
  }

  async poll(url, ms) {
    const deadline = Date.now() + ms;
    let last;
    while (Date.now() < deadline) {
      try {
        const r = await fetch(url);
        if (r.ok) return await r.json();
      } catch (e) { last = e; }
      await sleep(200);
    }
    throw new Error(`${this.label}: CDP 起不来（${url}）${last ? '：' + last.message : ''}`);
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
    await this.send('Runtime.enable', {}, sessionId);
    await this.send('Page.enable', {}, sessionId);
    await this.send('Log.enable', {}, sessionId);
    return { sessionId, targetId };
  }

  async eval(sessionId, expression) {
    const r = await this.send('Runtime.evaluate',
      { expression, returnByValue: true, awaitPromise: true }, sessionId);
    if (r.exceptionDetails) {
      throw new Error(r.exceptionDetails.exception?.description || r.exceptionDetails.text);
    }
    return r.result?.value;
  }

  async waitFor(sessionId, expression, ms = 15000, label = expression) {
    const deadline = Date.now() + ms;
    let lastErr;
    while (Date.now() < deadline) {
      try { if (await this.eval(sessionId, expression)) return true; } catch (e) { lastErr = e; }
      await sleep(120);
    }
    throw new Error(`${this.label} 等不到「${label}」${lastErr ? '：' + lastErr.message : ''}`);
  }

  async snap(sessionId) { return this.eval(sessionId, SNAP); }

  async key(sessionId, key, code, vk) {
    const base = { key, code, windowsVirtualKeyCode: vk, nativeVirtualKeyCode: vk };
    await this.send('Input.dispatchKeyEvent', { ...base, type: 'keyDown' }, sessionId);
    await this.send('Input.dispatchKeyEvent', { ...base, type: 'keyUp' }, sessionId);
  }

  async click(sessionId, x, y) {
    await this.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y }, sessionId);
    await this.send('Input.dispatchMouseEvent',
      { type: 'mousePressed', x, y, button: 'left', clickCount: 1 }, sessionId);
    await this.send('Input.dispatchMouseEvent',
      { type: 'mouseReleased', x, y, button: 'left', clickCount: 1 }, sessionId);
  }

  async close() {
    try { await withTimeout(this.send('Browser.close'), 4000, 'Browser.close'); } catch (e) { /* 无所谓 */ }
    await sleep(200);
    try { this.proc.kill(); } catch (e) { /* 已经退了 */ }
  }
}

// ---------------------------------------------------------------- 本地服务

function startServer(prefsPath) {
  // 注意 PYTHONIOENCODING：stdout 走管道时 Python 默认按系统编码（GBK）输出，
  // 所以下面解析地址只认 ASCII 部分，别去 match 中文提示。
  const proc = spawn(PYTHON, ['-u', '-m', 'dawview', PROJECT, '--no-window',
    '--port', String(PORT), '--prefs', prefsPath],
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

const api = (base, path, init) => fetch(`http://127.0.0.1:${new URL(base).port}${path}`, init);

// ------------------------------------------------------------------ 主流程

const work = mkdtempSync(join(tmpdir(), 'dawview-relay-'));
let server;
let A;
let B;
const targets = [];

try {
  if (!EDGE) throw new Error('找不到 Edge / Chrome，没法做端到端验证');

  step(`起本地服务（端口 ${PORT}，设置写 ${join(work, 'prefs.json')}）`);
  server = startServer(join(work, 'prefs.json'));
  const base = await server.ready;
  console.log(`  服务：${base}`);

  step('起两个独立 profile 的 Edge（app 窗口带 ?role=host，另一个当 OBS 浏览器源）');
  A = await Browser.launch(CDP_A, join(work, 'profile-a'), 'app');
  B = await Browser.launch(CDP_B, join(work, 'profile-b'), 'obs');
  const a = await A.open(`${base}/index.html?role=host`);
  const b = await B.open(`${base}/index.html`);
  targets.push(a.targetId, b.targetId);
  await A.waitFor(a.sessionId, `!!(window.dawview && window.dawview.state.project)`, 25000, 'app 窗口 boot');
  await B.waitFor(b.sessionId, `!!(window.dawview && window.dawview.state.project)`, 25000, 'OBS 页面 boot');
  await A.waitFor(a.sessionId, `window.dawview.getClientId() !== ''`, 10000, 'app 拿到 client id');
  await B.waitFor(b.sessionId, `window.dawview.getClientId() !== ''`, 10000, 'OBS 页面拿到 client id');

  let sa = await A.snap(a.sessionId);
  let sb = await B.snap(b.sessionId);
  const nTracks = await A.eval(a.sessionId, 'window.dawview.state.project.tracks.length');
  const initRowH = sa.rowH;

  step('1) 两个页面都连上了');
  check('app 窗口认自己是主窗口', sa.host === true, `host=${sa.host}`);
  check('OBS 页面不是主窗口', sb.host === false, `host=${sb.host}`);
  check('两个页面各自拿到了 client id', sa.clientId && sb.clientId && sa.clientId !== sb.clientId,
    `${sa.clientId} / ${sb.clientId}`);
  const health = await (await api(base, '/health')).json();
  check('/health 看到 2 个客户端', health.clients === 2, JSON.stringify(health));

  step('2) 控制中继：在 app 窗口按空格，OBS 那个页面跟着播');
  await A.send('Page.bringToFront', {}, a.sessionId);
  await A.key(a.sessionId, ' ', 'Space', 32);
  await B.waitFor(b.sessionId, 'window.dawview.state.playing === true', 5000, 'OBS 页面开始播放');
  sa = await A.snap(a.sessionId);
  sb = await B.snap(b.sessionId);
  check('OBS 页面在播', sb.playing === true);
  check('发起者没有被自己的回声再触发一次（还在播）', sa.playing === true, `playing=${sa.playing}`);
  check('OBS 页面记下了这次动作', (sb.relay.actions.play || 0) >= 1,
    `play=${sb.relay.actions.play || 0} 共 ${sb.relay.controls} 条（${Object.keys(sb.relay.actions).join('/')}）`);

  await A.key(a.sessionId, ' ', 'Space', 32);
  await B.waitFor(b.sessionId, 'window.dawview.state.playing === false', 5000, 'OBS 页面停播');
  check('再按一次空格两边都停', (await B.snap(b.sessionId)).playing === false
    && (await A.snap(a.sessionId)).playing === false);

  step('3) 定位中继：点 app 窗口的标尺，OBS 画面跳到同一个位置');
  const clickPoint = await A.eval(a.sessionId, `(() => {
    const r = document.getElementById('tl').getBoundingClientRect();
    return { x: r.left + window.dawview.state.view.headW + 220, y: r.top + 40 };
  })()`);
  await A.click(a.sessionId, clickPoint.x, clickPoint.y);
  const tickA = (await A.snap(a.sessionId)).tick;
  await B.waitFor(b.sessionId, `Math.abs(window.dawview.state.playheadTick - ${tickA}) < 1`,
    5000, 'OBS 页面跳到同一个 tick');
  check('两边播放头位置一致', (await B.snap(b.sessionId)).tick === tickA, `tick=${tickA}`);

  step('4) 视图选项中继：钢琴窗 / 行高 / 导出模式 / 轨道显示隐藏');
  await A.eval(a.sessionId, `window.dawview.setViewMode('midi')`);
  await B.waitFor(b.sessionId, `window.dawview.state.view.mode === 'midi'`, 5000, 'OBS 切到钢琴窗');
  check('视图模式跟着切', (await B.snap(b.sessionId)).viewMode === 'midi');

  await A.eval(a.sessionId, `window.dawview.setRowHeight(96)`);
  await B.waitFor(b.sessionId, `Math.round(window.dawview.state.rowH) === 96`, 5000, 'OBS 行高变化');
  check('行高跟着变', (await B.snap(b.sessionId)).rowH === 96);

  await A.eval(a.sessionId, `window.dawview.setExportMode(true)`);
  await B.waitFor(b.sessionId, `window.dawview.state.exportMode === true`, 5000, 'OBS 进导出模式');
  check('导出模式跟着开', (await B.snap(b.sessionId)).exportMode === true
    && await B.eval(b.sessionId, `document.body.classList.contains('export')`) === true);

  await A.eval(a.sessionId, `window.dawview.setTrackVisible(1, false)`);
  await B.waitFor(b.sessionId, `window.dawview.state.hiddenTracks.has(1)`, 5000, 'OBS 隐藏同一条轨道');
  check('隐藏轨道两边一致', JSON.stringify((await B.snap(b.sessionId)).hidden)
    === JSON.stringify((await A.snap(a.sessionId)).hidden));

  await A.eval(a.sessionId, `window.dawview.setExportMode(false);
    window.dawview.setViewMode('arrange');
    window.dawview.setTrackVisible(1, true);
    window.dawview.setRowHeight(${initRowH})`);
  await sleep(400);

  step('5) 设置同步（主题 + 轨道配色）：改了 app 窗口，OBS 那个实例跟着变');
  await A.eval(a.sessionId, `window.dawview.setTheme('midnight')`);
  await B.waitFor(b.sessionId, `JSON.parse(localStorage.getItem('dawview.theme') || '{}').name === 'midnight'`,
    5000, 'OBS 主题变成 midnight');
  sb = await B.snap(b.sessionId);
  check('OBS 页面用了新主题', sb.themeName === 'midnight' && sb.theme === '#0a0a0c',
    `${sb.themeName} ${sb.theme}`);

  await A.eval(a.sessionId, `window.dawview.setTrackColor(0, '#e2705f')`);
  await B.waitFor(b.sessionId, `/0:#e2705f/.test(Object.entries(window.dawview.state.trackColors)
    .map(([k, v]) => k + ':' + v).join(','))`, 5000, 'OBS 轨道配色跟上');
  check('轨道配色跟上了', (await B.snap(b.sessionId)).colors.includes('0:#e2705f'),
    (await B.snap(b.sessionId)).colors);

  const stored = await (await api(base, '/prefs')).json();
  check('服务端存下了这份设置', stored.theme?.name === 'midnight'
    && stored.colors?.map?.['0'] === '#e2705f', JSON.stringify(stored.theme || {}));

  step('6) OBS 那个页面清空 localStorage 后重载：设置从服务端拉回来');
  await B.eval(b.sessionId, `localStorage.clear(); location.reload()`);
  await B.waitFor(b.sessionId, `!!(window.dawview && window.dawview.state.project
    && window.dawview.getClientId() !== '')`, 25000, 'OBS 页面重载');
  await B.waitFor(b.sessionId, `JSON.parse(localStorage.getItem('dawview.theme') || '{}').name === 'midnight'`,
    8000, 'OBS 重载后主题仍是 midnight');
  sb = await B.snap(b.sessionId);
  check('重载后主题来自服务端', sb.themeName === 'midnight' && sb.theme === '#0a0a0c',
    `${sb.themeName} ${sb.theme}`);
  check('重载后轨道配色也回来了', sb.colors.includes('0:#e2705f'), sb.colors);

  step('7) 反过来也通：在 OBS 那个页面调主题，app 窗口跟着变');
  await B.eval(b.sessionId, `window.dawview.setTheme('paper')`);
  await A.waitFor(a.sessionId, `getComputedStyle(document.documentElement)
    .getPropertyValue('--bg').trim() === '#f0eee6'`, 5000, 'app 窗口跟着换主题');
  check('app 窗口跟着换了主题', (await A.snap(a.sessionId)).theme === '#f0eee6');

  step('8) 主窗口优先：app 窗口关掉重开，不该被服务端那份（OBS 改过的）覆盖');
  await A.eval(a.sessionId, `window.dawview.setTheme('neon')`);
  await B.waitFor(b.sessionId, `JSON.parse(localStorage.getItem('dawview.theme') || '{}').name === 'neon'`,
    5000, 'OBS 跟上 neon');
  await A.send('Target.closeTarget', { targetId: a.targetId });
  await sleep(500);
  await B.eval(b.sessionId, `window.dawview.setTheme('forest')`);   // 服务端这份变成 forest
  await sleep(600);
  const beforeReopen = await (await api(base, '/prefs')).json();
  check('服务端那份已被 OBS 页面改成 forest', beforeReopen.theme?.name === 'forest',
    beforeReopen.theme?.name);

  const a2 = await A.open(`${base}/index.html?role=host`);
  targets.push(a2.targetId);
  await A.waitFor(a2.sessionId, `!!(window.dawview && window.dawview.state.project
    && window.dawview.getClientId() !== '')`, 25000, 'app 窗口重开');
  const sa2 = await A.snap(a2.sessionId);
  check('重开的 app 窗口留住了自己那份设置（neon），没被 forest 覆盖',
    sa2.themeName === 'neon' && sa2.theme === '#0b0710', `${sa2.themeName} ${sa2.theme}`);
  await B.waitFor(b.sessionId, `JSON.parse(localStorage.getItem('dawview.theme') || '{}').name === 'neon'`,
    6000, 'OBS 跟着回到 neon');
  check('app 窗口把自己那份推回去后，OBS 又跟着回到 neon',
    (await B.snap(b.sessionId)).themeName === 'neon');
  check('服务端那份也回到 neon',
    (await (await api(base, '/prefs')).json()).theme?.name === 'neon');

  step('9) 播放时的位置校准：时钟主窗口定期报 tick');
  const beforeA = (await A.snap(a2.sessionId)).relay;
  const beforeB = (await B.snap(b.sessionId)).relay;
  await A.eval(a2.sessionId, `window.dawview.setPlaying(true)`);
  await B.waitFor(b.sessionId, `window.dawview.state.playing === true`, 5000, 'OBS 开始播放');
  for (let i = 0; i < 6; i++) {
    await A.eval(a2.sessionId, DRIVE_RAF(20));
    await B.eval(b.sessionId, DRIVE_RAF(20));
    await sleep(120);
  }
  const sa3 = await A.snap(a2.sessionId);
  const sb3 = await B.snap(b.sessionId);
  check('app 窗口（最近被操作的那个）在发位置校准',
    sa3.relay.sends - beforeA.sends >= 2, `发了 ${sa3.relay.sends - beforeA.sends} 条控制消息`);
  check('OBS 页面收到了校准，末条就是 tick',
    (sb3.relay.actions.tick || 0) >= 2 && sb3.relay.lastAction === 'tick',
    `收到 ${sb3.relay.controls - beforeB.controls} 条（tick ${(sb3.relay.actions.tick || 0)}），末条 ${sb3.relay.lastAction}`);
  check('反过来没有：跟随方不会自己也发一轮', sa3.relay.controls === beforeA.controls,
    `app 收到 ${sa3.relay.controls - beforeA.controls} 条`);
  check('两边播放头基本对齐', near(sa3.tick, sb3.tick, 400), `app=${sa3.tick} obs=${sb3.tick}`);
  check('OBS 页面确实在推进', sb3.tick > 0, `tick=${sb3.tick}`);
  await A.eval(a2.sessionId, `window.dawview.setPlaying(false)`);
  await B.waitFor(b.sessionId, `window.dawview.state.playing === false`, 5000, 'OBS 停播');

  step('10) 静下来之后不该有回声风暴');
  const q1a = (await A.snap(a2.sessionId)).relay;
  const q1b = (await B.snap(b.sessionId)).relay;
  await sleep(2500);
  const q2a = (await A.snap(a2.sessionId)).relay;
  const q2b = (await B.snap(b.sessionId)).relay;
  check('空闲 2.5 秒里 app 窗口没再发消息', q1a.plays === q2a.plays && q1a.prefs === q2a.prefs
    && q1a.controls === q2a.controls, `${JSON.stringify(q1a)} -> ${JSON.stringify(q2a)}`);
  check('空闲 2.5 秒里 OBS 页面没再收到消息', q1b.controls === q2b.controls && q1b.prefs === q2b.prefs,
    `${JSON.stringify(q1b)} -> ${JSON.stringify(q2b)}`);
  check('两边中继计数都很小（没有互相回声）', q2b.controls < 200 && q2a.prefs < 200,
    `obs.controls=${q2b.controls} app.prefs=${q2a.prefs}`);

  step('11) 外部工具也能驱动（直接 POST /control，不带 client id → 所有页面都执行）');
  const r1 = await (await api(base, '/control', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ action: 'setexport', params: { on: true } }),
  })).json();
  check('服务端接受了外部动作', r1.ok === true && r1.sent === 2, JSON.stringify(r1));
  await B.waitFor(b.sessionId, `window.dawview.state.exportMode === true`, 4000, 'OBS 进导出模式');
  check('两个页面都执行了', (await B.snap(b.sessionId)).exportMode === true
    && (await A.snap(a2.sessionId)).exportMode === true);
  await api(base, '/control', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ action: 'setexport', params: { on: false } }),
  });

  step('12) 页面里没有 JS 异常');
  check('app 窗口没有报错', A.errors.length === 0, A.errors.slice(0, 3).join(' | '));
  check('OBS 页面没有报错', B.errors.length === 0, B.errors.slice(0, 3).join(' | '));
} catch (err) {
  failed++;
  console.log(`\nERROR: ${err.message}`);
  if (server) console.log(server.tail());
} finally {
  if (A) await A.close();
  if (B) await B.close();
  if (server) { try { server.proc.kill(); } catch (e) { /* 已退 */ } }
  try { rmSync(work, { recursive: true, force: true, maxRetries: 5 }); } catch (e) { /* 临时目录 */ }
}

const total = passed + failed;
console.log(`\n${passed}/${total} 项通过`);
console.log(failed === 0 ? 'ALL RELAY CHECKS PASSED' : `${failed} CHECK(S) FAILED`);
process.exitCode = failed === 0 ? 0 : 1;
