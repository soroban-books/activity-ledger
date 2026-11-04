import { rpc, scValToNative } from '@stellar/stellar-sdk';
const server = new rpc.Server('https://mainnet.sorobanrpc.com');
const H = 'https://horizon.stellar.org';
const j = (u) => fetch(u).then(r => r.json());
const h = await server.getLatestLedger();
const ROUTER = 'CAG5LRYQ5JVEUI5TEID72EYOVX44TTUJT5BQR2J6J77FH65PCCFAJDDH';
const r = await server.getEvents({ startLedger: h.sequence - 30000, filters: [{ type: 'contract', contractIds: [ROUTER] }], limit: 200 });
const cands = [];
for (const e of r.events) {
  const t = e.topic.map(scValToNative); if (t[1] !== 'swap') continue;
  const to = scValToNative(e.value).to; if (typeof to !== 'string' || !to.startsWith('G')) continue;
  cands.push({ to, hash: e.txHash, ledger: e.ledger });
}
const seen = new Set(); let tested = 0;
for (const c of cands) {
  if (seen.has(c.to + c.hash)) continue; seen.add(c.to + c.hash);
  const tx = await j(`${H}/transactions/${c.hash}`);
  if (tx.source_account === c.to || tx.fee_account === c.to) continue;
  // page the account's tx list until we pass the target ledger, so list depth cannot explain a miss
  let url = `${H}/accounts/${c.to}/transactions?order=desc&limit=200&include_failed=true`, listed = false, oldest = null, pages = 0;
  while (url && pages < 6) {
    const page = await j(url); const recs = page._embedded?.records ?? []; pages++;
    if (!recs.length) break;
    if (recs.some(x => x.hash === c.hash)) { listed = true; break; }
    oldest = recs[recs.length - 1].ledger;
    if (oldest <= c.ledger) break; // list already extends past the target ledger
    url = page._links?.next?.href;
  }
  console.log(`to=${c.to.slice(0,8)} txLedger=${c.ledger} source=${tx.source_account.slice(0,8)} listed=${listed} listCoversLedger=${oldest !== null && oldest <= c.ledger} pages=${pages}`);
  if (++tested >= 8) break;
}
