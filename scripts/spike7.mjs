import zlib from 'node:zlib'; import { xdr } from '@stellar/stellar-sdk';
import { lakeUrl } from '../src/sources/lake.ts';
const raw = zlib.zstdDecompressSync(Buffer.from(await (await fetch(lakeUrl(65029187))).arrayBuffer()));
const lcm = xdr.LedgerCloseMetaBatch.fromXDR(raw).ledgerCloseMetas[0]; const v = lcm[lcm.type];
const seen = new Set();
for (const tp of v.txProcessing) { const m=tp.txApplyProcessing; const i=m[m.type];
  for (const o of i.operations) for (const e of o.events) seen.add(String(e.type)+'|'+typeof e.type);
  for (const w of i.events) seen.add('tl:'+String(w.event.type)+'|'+w.stage);
}
console.log([...seen]);
