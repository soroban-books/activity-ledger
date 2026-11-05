import { scValToNative, xdr } from '@stellar/stellar-sdk';
import { rpcCall } from '../src/sources/rpc.ts';
const latest = (await rpcCall('getLatestLedger', null)).sequence;
const topic = xdr.ScVal.scvSymbol('flash_loan').toXDR('base64');
const r: any = await rpcCall('getEvents', { startLedger: latest - 120_000, pagination: { limit: 3 }, filters: [{ type: 'contract', topics: [[topic, '*', '*', '*']] }] });
for (const e of r.events) console.log(e.contractId, e.ledger, e.txHash, JSON.stringify(e.topic.map((t: string) => scValToNative(xdr.ScVal.fromXDR(t, 'base64'))), (_k, v) => typeof v === 'bigint' ? v.toString() : v));
