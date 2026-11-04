import { xdr } from '@stellar/stellar-sdk';
import zlib from 'node:zlib';
const B = 'https://aws-public-blockchain.s3.us-east-2.amazonaws.com/v1.1/stellar/ledgers/pubnet';
const seq = 65102936;
const hex = (n) => (0xFFFFFFFF - n).toString(16).toUpperCase().padStart(8, '0');
const pStart = Math.floor(seq / 64000) * 64000;
const url = `${B}/${hex(pStart)}--${pStart}-${pStart+63999}/${hex(seq)}--${seq}.xdr.zst`;
const raw = zlib.zstdDecompressSync(Buffer.from(await (await fetch(url)).arrayBuffer()));
const batch = xdr.LedgerCloseMetaBatch.fromXDR(raw);
console.log('batch keys', Object.keys(batch));
const lcm = batch.ledgerCloseMetas[0];
console.log('lcm keys', Object.keys(lcm), typeof lcm.switch, lcm.arm ?? lcm._arm);
const show = (o, d=0) => { if (d>3||o==null) return; for (const k of Object.keys(o).slice(0,12)) { const v=o[k]; console.log(' '.repeat(d*2)+k, Array.isArray(v)?`[${v.length}]`:typeof v); if (v && typeof v==='object' && !Array.isArray(v) && !(v instanceof Uint8Array)) show(v,d+1);} };
show(lcm);
console.log('=== tx level');
const tp = lcm.v2.txProcessing[0];
console.log(Object.keys(tp), Object.keys(tp.txApplyProcessing), tp.txApplyProcessing.type);
const m = tp.txApplyProcessing;
const inner = m[m.type];
console.log('meta inner keys', Object.keys(inner));
import { scValToNative } from '@stellar/stellar-sdk';
let n=0;
for (const t of lcm.v2.txProcessing) {
  const mm = t.txApplyProcessing; const iv = mm[mm.type];
  const evs = mm.type==='v4' ? iv.operations.flatMap(o=>o.events) : (iv.sorobanMeta?.events ?? []);
  if (evs.length && n++<2) {
    console.log('hash', Buffer.from(t.result.transactionHash).toString('hex').slice(0,12), 'metaType', mm.type, 'events', evs.length);
    const e = evs[0]; console.log(Object.keys(e), e.type, Object.keys(e.body));
    console.log('contractId', e.contractId ? Object.keys(e.contractId) : null);
  }
}
