import { xdr, scValToNative } from '@stellar/stellar-sdk';
import zlib from 'node:zlib';
const B = 'https://aws-public-blockchain.s3.us-east-2.amazonaws.com/v1.1/stellar/ledgers/pubnet';
const seq = Number(process.argv[2] || 65102936);
const FILES = 1, PARTS = 64000;
const hex = (n) => (0xFFFFFFFF - n).toString(16).toUpperCase().padStart(8, '0');
const pStart = Math.floor(seq / PARTS) * PARTS, pEnd = pStart + PARTS - 1;
const part = `${hex(pStart)}--${pStart}-${pEnd}`;
const key = `${hex(seq)}--${seq}.xdr.zst`;
const url = `${B}/${part}/${key}`;
const res = await fetch(url); console.log(url, res.status);
const buf = Buffer.from(await res.arrayBuffer());
const raw = zlib.zstdDecompressSync(buf);
console.log('bytes', buf.length, '->', raw.length);
const batch = xdr.LedgerCloseMetaBatch.fromXDR(raw);
const lcm = batch.ledgerCloseMetas()[0];
console.log('lcm v', lcm.switch());
const v = lcm.value ? lcm.value() : lcm.v2();
const txs = v.txProcessing();
console.log('txs', txs.length);
let shown = 0;
for (const tp of txs) {
  const meta = tp.txApplyProcessing();
  const sw = meta.switch();
  let evs = [];
  if (sw === 4) evs = meta.v4().operations().flatMap(o => o.events());
  else if (sw === 3) evs = meta.v3().sorobanMeta()?.events() ?? [];
  const hash = Buffer.from(tp.result().transactionHash()).toString('hex');
  if (evs.length && shown < 3) {
    shown++;
    console.log('tx', hash.slice(0,10), 'meta v'+sw, 'events', evs.length);
    for (const e of evs.slice(0,6)) {
      const b = e.event ? e.event() : e;
      const body = b.body().v0();
      const cid = b.contractId() ? Buffer.from(b.contractId()).toString('hex').slice(0,8) : null;
      console.log('  ', cid, JSON.stringify(body.topics().map(t=>scValToNative(t)), (k,x)=>typeof x==='bigint'?x.toString():x), JSON.stringify(scValToNative(body.data()), (k,x)=>typeof x==='bigint'?x.toString():x));
    }
  }
}
