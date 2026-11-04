import { rpc, scValToNative, xdr } from '@stellar/stellar-sdk';
const RPC = 'https://mainnet.sorobanrpc.com';
const server = new rpc.Server(RPC);
const POOL = 'CAJJZSGMMM3PD7N33TAPHGBUGTB43OC73HVIK2L2G6BNGGGYOSSYBXBD';
const h = await server.getLatestLedger();
const start = h.sequence - 17000; // ~1 day
const r = await server.getEvents({ startLedger: start, filters: [{ type: 'contract', contractIds: [POOL] }], limit: 40 });
console.log('events', r.events.length, 'latest', h.sequence);
for (const e of r.events.slice(0, 40)) {
  const topics = e.topic.map(t => scValToNative(t));
  const data = scValToNative(e.value);
  console.log(e.ledger, e.txHash.slice(0,10), JSON.stringify(topics, (k,v)=>typeof v==='bigint'?v.toString():v), JSON.stringify(data, (k,v)=>typeof v==='bigint'?v.toString():v));
}
