/** Per-request timeline of a sync. Run: node scripts/bench-timeline.ts G... [limit] [concurrency] */
import fs from 'node:fs';
import { syncAccount } from '../src/sync.ts';
import { LakeSource } from '../src/sources/lake.ts';
import { httpFetch, type Fetcher } from '../src/sources/net.ts';

const [account, limitArg, concArg] = process.argv.slice(2);
const t0 = performance.now();
const at = (): string => ((performance.now() - t0) / 1000).toFixed(1).padStart(6);
let inflight = 0;
const logged: Fetcher = async (url) => {
  const s = performance.now();
  inflight++;
  const kind = url.includes('horizon') ? 'HORIZON' : 'lake   ';
  const r = await httpFetch(url);
  inflight--;
  const size = r.status === 200 ? (await r.arrayBuffer()).byteLength : 0;
  console.log(`${at()}s ${kind} ${((performance.now() - s) / 1000).toFixed(1).padStart(5)}s ${(size / 1024) | 0}KB inflight=${inflight} ${url.split('/').pop()!.slice(0, 40)}`);
  return r;
};
const cacheDir = `/tmp/al-tl-${Date.now()}`;
fs.mkdirSync(cacheDir, { recursive: true });
const lake = new LakeSource({ cacheDir, fetchImpl: logged });
const r = await syncAccount(account!, { limit: Number(limitArg ?? 24), concurrency: concArg ? Number(concArg) : undefined, lake, fetchImpl: logged, onTx: () => {} });
console.log(`${at()}s DONE`, JSON.stringify(r));
await lake.close();
