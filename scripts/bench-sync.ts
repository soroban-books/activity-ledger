/** End-to-end sync timing. Run: node scripts/bench-sync.ts G... [limit=24] [cacheDir]  (fresh cacheDir => honest cold timing) */
import fs from 'node:fs';
import { syncAccount } from '../src/sync.ts';
import { LakeSource } from '../src/sources/lake.ts';

const [account, limitArg, cacheArg] = process.argv.slice(2);
const limit = Number(limitArg ?? 24);
const cacheDir = cacheArg ?? `/tmp/al-bench-${Date.now()}`;
fs.rmSync(cacheDir, { recursive: true, force: true });
const lake = new LakeSource({ cacheDir });
const t0 = performance.now();
let first = 0;
let n = 0;
try {
  const r = await syncAccount(account!, { limit, lake, onTx: () => { if (!n++) first = performance.now() - t0; } });
  const total = (performance.now() - t0) / 1000;
  console.log(JSON.stringify({ ...r, limit, firstTxSec: +(first / 1000).toFixed(1), totalSec: +total.toFixed(1), secPerTx: +(total / Math.max(1, r.txs)).toFixed(2), ledgersDownloaded: fs.readdirSync(cacheDir).length }));
} catch (e) {
  console.log('ERR', (e as Error).message, (e as any).cause?.code ?? '');
} finally {
  await lake.close();
}
