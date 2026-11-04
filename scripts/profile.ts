/** Where does ledger decode time go? Run: node scripts/profile.ts  (uses .cache/lake). */
import fs from 'node:fs';
import zlib from 'node:zlib';
import { xdr } from '@stellar/stellar-sdk';
import { decodeLedgerMeta } from '../src/sources/lake.ts';

const dir = '.cache/lake';
const files = fs.readdirSync(dir).filter((f) => f.endsWith('.zst')).slice(-4);
for (const f of files) {
  const seq = Number(f.split('.')[0]);
  let t = performance.now();
  const raw = zlib.zstdDecompressSync(fs.readFileSync(`${dir}/${f}`));
  const zstd = performance.now() - t;
  t = performance.now();
  xdr.LedgerCloseMetaBatch.fromXDR(raw as Buffer);
  const parse = performance.now() - t;
  t = performance.now();
  const L = decodeLedgerMeta(raw, seq);
  const full = performance.now() - t;
  console.log(f, `rawKB=${(raw.length / 1024) | 0}`, `zstd=${zstd.toFixed(0)}ms`, `fromXDR=${parse.toFixed(0)}ms`, `fullDecode=${full.toFixed(0)}ms`, `txs=${L.txs.size}`);
}
