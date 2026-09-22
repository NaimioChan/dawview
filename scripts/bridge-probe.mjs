// 桥行为诊断：连到真实 webui 服务，看 window.webui / isConnected / loadProject 的真实返回
const CDP = 'http://127.0.0.1:9223';
const TARGET = process.argv[2];
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const targets = await (await fetch(`${CDP}/json`)).json();
const page = targets.find((t) => t.type === 'page' && !t.url.startsWith('chrome://'));
const ws = new WebSocket(page.webSocketDebuggerUrl);
await new Promise((res) => { ws.onopen = res; });
let id = 0; const pending = new Map();
ws.onmessage = (e) => { const m = JSON.parse(e.data); if (m.id && pending.has(m.id)) { const p = pending.get(m.id); pending.delete(m.id); m.error ? p.rej(new Error(m.error.message)) : p.res(m.result); } };
const send = (method, params = {}) => new Promise((res, rej) => { const i = ++id; pending.set(i, { res, rej }); ws.send(JSON.stringify({ id: i, method, params })); });
const ev = async (expression) => {
  const r = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
  if (r.exceptionDetails) return { __exc: r.exceptionDetails.text + ' ' + (r.exceptionDetails.exception?.description || '') };
  return r.result?.value;
};

await send('Page.enable');
await send('Page.navigate', { url: TARGET });
await sleep(3000);

console.log('webui 存在:', await ev(`typeof window.webui`));
console.log('有 call:', await ev(`typeof (window.webui||{}).call`));
console.log('isConnected:', await ev(`(() => { try { return String(window.webui.isConnected()) } catch (e) { return 'EXC ' + e.message } })()`));
console.log('dataSource:', await ev(`window.dawview ? window.dawview.state.dataSource : 'no-dawview'`));
console.log('status:', await ev(`document.getElementById('status-text').textContent`));
console.log('直接调 loadProject 前 60 字符:', await ev(`(async () => { try { const r = await window.webui.call('loadProject'); return String(r).slice(0,60) } catch (e) { return 'EXC ' + e.message } })()`));
ws.close();
