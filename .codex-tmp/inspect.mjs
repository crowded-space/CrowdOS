// inspect.mjs — evaluate JS in the Electron MAIN process via :9229
// Usage: node inspect.mjs --file <exprFile>  |  node inspect.mjs "<expr>"
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
const wrapped = "(async () => { " + expr + " })()";
const r = await send('Runtime.evaluate', { expression: wrapped, awaitPromise: true, returnByValue: true, timeout: 60000 });
const out = { ok: !r.result?.exceptionDetails, result: r.result?.result?.value, exception: r.result?.exceptionDetails?.exception?.description || r.result?.exceptionDetails?.text };
console.log(JSON.stringify(out, null, 2));
ws.close();

