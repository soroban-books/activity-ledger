import zlib from 'node:zlib'; import { xdr } from '@stellar/stellar-sdk';
import { lakeUrl } from '../src/sources/lake.ts';
const raw = zlib.zstdDecompressSync(Buffer.from(await (await fetch(lakeUrl(65029187))).arrayBuffer()));
const lcm = xdr.LedgerCloseMetaBatch.fromXDR(raw).ledgerCloseMetas[0]; const v = lcm[lcm.type];
let n=0;
for (const tp of v.txProcessing) { const m=tp.txApplyProcessing; const i=m[m.type];
  const ops = i.operations.filter(o=>o.events.length); const tl=i.events;
  if ((ops.length||tl.length) && n++<2) {
    console.log('tx-level events', tl.length, tl[0] && Object.keys(tl[0]), tl[0] && JSON.stringify(Object.keys(tl[0].event||{})));
    if (ops[0]) { const e=ops[0].events[0]; console.log('op event keys', Object.keys(e), e.type, e.stage); }
  } }
