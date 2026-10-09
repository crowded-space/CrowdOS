// rinspect.mjs — evaluate JS in the Electron renderer via main-process inspector
// Usage: node rinspect.mjs --file <exprFile>   (expr runs in RENDERER, async ok)
import { readFileSync } from 'node:fs';
const list = await fetch('http://127.0.0.1:9229/json/list').then(r => r.json());
if (!list.length) { console.error('no targets'); process.exit(1); }
const ws = new WebSocket(list[0].webSocketDebuggerUrl);
let id = 0;
const pending = new Map();
ws.onmessage = (ev) => {
  const msg = JSON.parse(ev.data);
  if (msg.id && pending.has(msg.id)) { pending.get(msg.id)(msg); pending.delete(msg.id); }
};
function send(method, params) {
  return new Promise(res => { const i = ++id; pending.set(i, res); ws.send(JSON.stringify({ id: i, method, params })); });
}
await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });
await send('Runtime.enable', {});
let expr;
if (process.argv[2] === '--file') expr = readFileSync(process.argv[3], 'utf8');
else expr = process.argv[2] || '1+1';
const wrapped = "(async () => { const m = process.mainModule && process.mainModule.require ? process.mainModule.require('electron') : null; if (!m) return { err: 'no electron module' }; const wins = m.BrowserWindow.getAllWindows(); const w = wins.find(x => x.webContents.getURL().indexOf('22077') !== -1) || wins[0]; if (!w) return { err: 'no window' }; return await w.webContents.executeJavaScript(" + JSON.stringify("(async () => { " + expr + " })()") + ", true); })()";
const r = await send('Runtime.evaluate', { expression: wrapped, awaitPromise: true, returnByValue: true, timeout: 60000 });
const out = { ok: !r.result?.exceptionDetails, result: r.result?.result?.value, exception: r.result?.exceptionDetails?.exception?.description || r.result?.exceptionDetails?.text };
console.log(JSON.stringify(out, null, 2));
ws.close();

