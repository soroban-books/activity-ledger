import { rpc, scValToNative } from '@stellar/stellar-sdk';
const server = new rpc.Server('https://mainnet.sorobanrpc.com');
const H = 'https://horizon.stellar.org';
const h = await server.getLatestLedger();
const ROUTER = 'CAG5LRYQ5JVEUI5TEID72EYOVX44TTUJT5BQR2J6J77FH65PCCFAJDDH';
let cursor, checked = 0, found = 0;
for (let p = 0; p < 10 && checked < 6; p++) {
  const req = cursor ? { cursor, filters: [{ type: 'contract', contractIds: [ROUTER] }], limit: 100 } : { startLedger: h.sequence - 30000, filters: [{ type: 'contract', contractIds: [ROUTER] }], limit: 100 };
  const r = await server.getEvents(req); if (!r.events.length) break; cursor = r.cursor;
  for (const e of r.events) {
    const t = e.topic.map(scValToNative); if (t[1] !== 'swap') continue;
    const to = scValToNative(e.value).to; if (typeof to !== 'string' || !to.startsWith('G')) continue;
    const tx = await (await fetch(`${H}/transactions/${e.txHash}`)).json();
    if (tx.source_account === to || tx.fee_account === to) continue; // want an indirect recipient
    checked++;
    const list = await (await fetch(`${H}/accounts/${to}/transactions?order=desc&limit=200&include_failed=true`)).json();
    const listed = (list._embedded?.records ?? []).some(x => x.hash === e.txHash);
    console.log('indirect recipient', to.slice(0, 8), 'tx', e.txHash.slice(0, 10), 'source', tx.source_account.slice(0, 8), 'LISTED_IN_HORIZON_ACCOUNT_TXS =', listed);
    if (listed) found++;
    if (checked >= 6) break;
  }
}
console.log({ checked, listed: found });
