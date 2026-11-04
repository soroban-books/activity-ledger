import { rpc, scValToNative } from '@stellar/stellar-sdk';
import { jsonSafe } from '../src/util.ts';
const server = new rpc.Server('https://mainnet.sorobanrpc.com');
const ROUTER = process.argv[2] || 'CAG5LRYQ5JVEUI5TEID72EYOVX44TTUJT5BQR2J6J77FH65PCCFAJDDH';
const h = await server.getLatestLedger();
const r = await server.getEvents({ startLedger: h.sequence - 100000, filters: [{ type: 'contract', contractIds: [ROUTER] }], limit: 10 });
console.log('router events', r.events.length);
const hashes = new Set();
for (const e of r.events) { hashes.add(e.txHash); console.log(e.ledger, e.txHash.slice(0,10), jsonSafe(e.topic.map(scValToNative)), jsonSafe(scValToNative(e.value)).slice(0,200)); }
console.log([...hashes].slice(0,3).join('\n'));
