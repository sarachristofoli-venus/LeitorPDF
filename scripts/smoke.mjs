// Teste de fumaça: node scripts/smoke.mjs <pasta-saida> <pdf...>
import { spawn } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import fs from 'node:fs';
import path from 'node:path';
const [out, ...pdfs] = process.argv.slice(2);
fs.mkdirSync(out, { recursive: true });
const electron = process.env.LEITOR_EXE || path.resolve('node_modules/electron/dist/electron.exe');
const proc = spawn(electron, [...(process.env.LEITOR_EXE ? [] : ['.']), '--remote-debugging-port=9333', `--user-data-dir=${path.join(out, 'profile')}`, ...pdfs], { stdio: 'inherit' });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let target;
for (let i = 0; i < 60 && !target; i++) {
  await sleep(500);
  try { target = (await (await fetch('http://127.0.0.1:9333/json/list')).json()).find((t) => t.url.startsWith('app://')); } catch {}
}
if (!target) { console.error('sem alvo'); proc.kill(); process.exit(1); }
const ws = new WebSocket(target.webSocketDebuggerUrl);
await new Promise((r) => ws.addEventListener('open', r));
let id = 0; const pending = new Map();
ws.addEventListener('message', (m) => {
  const d = JSON.parse(m.data);
  if (d.id && pending.has(d.id)) { pending.get(d.id)(d); pending.delete(d.id); }
  else if (d.method === 'Runtime.exceptionThrown') console.log('EXCEÇÃO:', JSON.stringify(d.params.exceptionDetails).slice(0, 600));
  else if (d.method === 'Runtime.consoleAPICalled' && ['error', 'warning'].includes(d.params.type)) console.log('CONSOLE', d.params.type, d.params.args.map((a) => a.value ?? a.description).join(' ').slice(0, 400));
});
const send = (method, params = {}) => new Promise((r) => { const i = ++id; pending.set(i, r); ws.send(JSON.stringify({ id: i, method, params })); });
const ev = async (expr) => { const r = await send('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true }); return r.result?.result?.value ?? r.result?.exceptionDetails?.exception?.description; };
const shot = async (name) => { const r = await send('Page.captureScreenshot', { format: 'png' }); fs.writeFileSync(path.join(out, name + '.png'), Buffer.from(r.result.data, 'base64')); };
const key = async (k, code, mods = 0, vk) => { for (const type of ['rawKeyDown', 'keyUp']) await send('Input.dispatchKeyEvent', { type, key: k, code, modifiers: mods, windowsVirtualKeyCode: vk }); };
await send('Runtime.enable');
const steps = (await import(pathToFileURL(path.resolve(out, 'steps.mjs')).href)).default;
try { await steps({ ev, shot, key, sleep, send }); } catch (e) { console.error('FALHA', e); }
ws.close(); proc.kill();
process.exit(0);
