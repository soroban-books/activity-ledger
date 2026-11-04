/** Time each stage of a sync separately: Horizon page, lake download, worker startup. Run: node scripts/bench-stages.ts G... */
import { Worker } from 'node:worker_threads';
import { accountTransactions } from '../src/sources/horizon.ts';
import { lakeUrl } from '../src/sources/lake.ts';

const account = process.argv[2]!;
const ms = (t: number): string => (performance.now() - t).toFixed(0) + 'ms';

let t = performance.now();
const hs: { ledger: number; hash: string }[] = [];
for await (const h of accountTransactions(account, {})) {
  hs.push(h);
  if (hs.length >= 5) break;
}
console.log('horizon first 5 txs:', ms(t), hs.map((h) => h.ledger).join(','));

for (const h of hs.slice(0, 3)) {
  t = performance.now();
  const r = await fetch(lakeUrl(h.ledger));
  const b = await r.arrayBuffer();
  console.log(`lake ${h.ledger}: ${r.status} ${(b.byteLength / 1024) | 0}KB in ${ms(t)}`);
}

t = performance.now();
const w = new Worker(new URL('../src/sources/lake-worker.ts', import.meta.url));
await new Promise<void>((res) => { w.once('message', () => res()); w.postMessage({ id: 1, ledger: 1, raw: new Uint8Array(4), wanted: null }); });
console.log('worker cold start (until first reply, incl. sdk import):', ms(t));
await w.terminate();
