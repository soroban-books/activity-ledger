/** Page through a contract's recent events and print the ones whose name matches: CONTRACT=C... node scripts/blend-probe-names.ts name1 name2 ... */
import { scValToNative, xdr } from '@stellar/stellar-sdk';
import { rpcCall } from '../src/sources/rpc.ts';
const dec = (b64: string) => scValToNative(xdr.ScVal.fromXDR(b64, 'base64'));
const j = (v: unknown): string => JSON.stringify(v, (_k, x) => (typeof x === 'bigint' ? x.toString() : x));
const want = new Set(process.argv.slice(2));
const contract = process.env.CONTRACT!;
const latest = (await rpcCall('getLatestLedger', null)).sequence;
const counts = new Map<string, number>();
let cursor: string | undefined;
let pages = 0;
let total = 0;
for (; pages < 60; pages++) {
  const filters = [{ type: 'contract', contractIds: [contract] }];
  const r: any = await rpcCall('getEvents', cursor ? { pagination: { cursor, limit: 200 }, filters } : { startLedger: latest - 120_000, pagination: { limit: 200 }, filters });
  for (const e of r.events) {
    total++;
    const topics = e.topic.map((t: string) => dec(t));
    const n = String(topics[0]);
    counts.set(n, (counts.get(n) ?? 0) + 1);
    if (want.has(n)) console.log(`L${e.ledger} tx=${e.txHash} ${j(topics).slice(0, 170)} ${j(dec(e.value)).slice(0, 220)}`);
  }
  cursor = r.cursor;
  if (r.events.length < 200) break;
}
console.error(`pages=${pages + 1} events=${total}`, JSON.stringify(Object.fromEntries(counts)));
