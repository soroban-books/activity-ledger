import fs from 'node:fs';
import zlib from 'node:zlib';
import { decodeLedgerMeta } from '../src/sources/lake.ts';
const files = fs.readdirSync('.cache/lake').slice(0, 5);
for (const f of files) {
  const seq = Number(f.split('.')[0]);
  const comp = fs.readFileSync(`.cache/lake/${f}`);
  let t = performance.now();
  const raw = zlib.zstdDecompressSync(comp);
  const t1 = performance.now() - t; t = performance.now();
  const L = decodeLedgerMeta(raw, seq);
  console.log(seq, 'bytes', comp.length, 'zstd ms', t1.toFixed(0), 'decode ms', (performance.now() - t).toFixed(0), 'txs', L.txs.size);
}
let t = performance.now();
const r = await fetch('https://horizon.stellar.org/accounts/GBJMQBKQL6FQ6BFZ52YJGY6SEMEER3DSTICPIYBZR3P4T2FUDYZEHUN7/transactions?order=asc&limit=200&include_failed=true');
const j: any = await r.json();
console.log('horizon page ms', (performance.now() - t).toFixed(0), r.status, j._embedded.records.length);
