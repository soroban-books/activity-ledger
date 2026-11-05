/**
 * Capture real screenshots of the running web UI for the landing page (site/img).
 * Start the server on a database that already holds a synced account first:
 *   node src/cli.ts serve --db ledger.sqlite --port 4173
 *   node scripts/capture-site-images.mjs <outDir>
 * Uses headless Chrome over the DevTools protocol (no extra dependencies).
 */
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const out = path.resolve(process.argv[2] ?? 'site/img');
fs.mkdirSync(out, { recursive: true });
const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'al-shot-'));
const chrome = spawn('google-chrome', ['--headless=new', '--no-sandbox', '--disable-gpu', '--remote-debugging-port=9334', `--user-data-dir=${profile}`, 'about:blank'], { stdio: 'ignore' });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let targets;
for (let i = 0; i < 40; i++) { try { targets = await (await fetch('http://127.0.0.1:9334/json')).json(); if (targets.length) break; } catch { /* starting */ } await sleep(250); }
const ws = new WebSocket(targets.find((t) => t.type === 'page').webSocketDebuggerUrl);
await new Promise((r) => (ws.onopen = r));
let id = 0;
const pending = new Map();
ws.onmessage = (m) => { const d = JSON.parse(m.data); if (d.id && pending.has(d.id)) { pending.get(d.id)(d); pending.delete(d.id); } };
const send = (method, params = {}) => new Promise((r) => { const i = ++id; pending.set(i, r); ws.send(JSON.stringify({ id: i, method, params })); });
const ev = async (expression) => (await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true })).result?.result?.value;

for (const mode of ['dark', 'light']) {
  await send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-color-scheme', value: mode }, { name: 'prefers-reduced-motion', value: 'reduce' }] });
  await send('Emulation.setDeviceMetricsOverride', { width: 1180, height: 1000, deviceScaleFactor: 2, mobile: false });
  await send('Page.navigate', { url: 'http://localhost:4173/' });
  const waitFor = async (expr, what) => {
    for (let i = 0; i < 60; i++) { if (await ev(expr)) return; await sleep(500); }
    throw new Error(`timed out waiting for ${what}`);
  };
  await waitFor(`!!document.querySelector('#stored button')`, 'stored accounts (is the server running on a synced database?)');
  await ev(`document.querySelector('#stored button').click()`);
  await waitFor(`!document.getElementById('report-body').hidden`, 'the report');
  await sleep(500);
  for (const [name, tab] of [['report', 'Events'], ['positions', 'Balances']]) {
    await ev(`[...document.querySelectorAll('.tab')].find((b) => b.textContent.startsWith('${tab}')).click()`);
    await sleep(400);
    // clip to the report section, capped so the image stays a readable size
    const r = await ev(`(() => { const e = document.getElementById('report'); const b = e.getBoundingClientRect(); return { x: b.left + scrollX, y: b.top + scrollY, w: b.width, h: b.height }; })()`);
    const height = Math.min(r.h, name === 'report' ? 780 : 570);
    const shot = await send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: true, clip: { x: r.x - 16, y: r.y - 8, width: r.w + 32, height: height + 16, scale: 1 } });
    fs.writeFileSync(path.join(out, `${name}-${mode}.png`), Buffer.from(shot.result.data, 'base64'));
    console.log('wrote', `${name}-${mode}.png`, Math.round(r.w), 'x', Math.round(height));
  }
}
chrome.kill();
try { fs.rmSync(profile, { recursive: true, force: true }); } catch { /* chrome may still be exiting */ }
process.exit(0);
