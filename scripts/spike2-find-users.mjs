import { rpc, scValToNative } from '@stellar/stellar-sdk';
const server = new rpc.Server('https://mainnet.sorobanrpc.com');
const POOLS = {
  FixedV2: 'CAJJZSGMMM3PD7N33TAPHGBUGTB43OC73HVIK2L2G6BNGGGYOSSYBXBD',
  YieldBloxV2: 'CCCCIQSDILITHMM7PBSLVDT5MISSY7R26MNZXCX4H7J5JQ5FPIYOGYFS',
};
const h = await server.getLatestLedger();
const found = new Map();
let cursor;
for (let page = 0; page < 8; page++) {
  const req = cursor ? { cursor, filters: [{ type: 'contract', contractIds: Object.values(POOLS) }], limit: 200 }
    : { startLedger: h.sequence - 100000, filters: [{ type: 'contract', contractIds: Object.values(POOLS) }], limit: 200 };
  const r = await server.getEvents(req);
  for (const e of r.events) {
    const t = e.topic.map(x => scValToNative(x));
    const who = t[2];
    if (typeof who === 'string' && who.startsWith('G')) {
      const k = who; const v = found.get(k) || { n: 0, names: new Set(), tx: e.txHash };
      v.n++; v.names.add(t[0]); found.set(k, v);
    }
  }
  cursor = r.cursor; if (!r.events.length) break;
}
const top = [...found.entries()].sort((a,b)=>b[1].n-a[1].n).slice(0,8);
for (const [k,v] of top) console.log(k, v.n, [...v.names].join(','), v.tx);
