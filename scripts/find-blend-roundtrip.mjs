import { rpc, scValToNative } from '@stellar/stellar-sdk';
const server = new rpc.Server('https://mainnet.sorobanrpc.com');
const POOLS = ['CAJJZSGMMM3PD7N33TAPHGBUGTB43OC73HVIK2L2G6BNGGGYOSSYBXBD','CCCCIQSDILITHMM7PBSLVDT5MISSY7R26MNZXCX4H7J5JQ5FPIYOGYFS'];
const h = await server.getLatestLedger();
const byAcc = new Map(); let cursor;
for (let p = 0; p < 12; p++) {
  const req = cursor ? { cursor, filters: [{ type: 'contract', contractIds: POOLS }], limit: 200 } : { startLedger: h.sequence - 115000, filters: [{ type: 'contract', contractIds: POOLS }], limit: 200 };
  const r = await server.getEvents(req); if (!r.events.length) break; cursor = r.cursor;
  for (const e of r.events) { const t = e.topic.map(scValToNative); const who = t[2]; if (typeof who==='string' && who.startsWith('G')) { const v = byAcc.get(who) ?? []; v.push([e.ledger, t[0], e.txHash, t[1]]); byAcc.set(who, v); } }
}
for (const [a, v] of byAcc) { const names = new Set(v.map(x=>x[1])); if ([...names].some(n=>n.startsWith('supply')) && [...names].some(n=>n.startsWith('withdraw'))) { console.log(a); for (const x of v) console.log('  ', x[0], x[1], x[2]); } }
