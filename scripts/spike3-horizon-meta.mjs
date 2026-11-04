import { xdr, scValToNative, StrKey } from '@stellar/stellar-sdk';
const H = 'https://horizon.stellar.org';
const ACC = process.argv[2] || 'GDMCUWYGHGOM2AIWVFJVW6PW3Y77CL5BSIF67BKHOMDEZMCXHFQW7VTK';
const j = (u) => fetch(u).then(r => r.json());
const txs = await j(`${H}/accounts/${ACC}/transactions?limit=10&order=desc&include_failed=true`);
console.log('account txs', txs._embedded.records.length);
for (const t of txs._embedded.records.slice(0, 6)) {
  const meta = xdr.TransactionMeta.fromXDR(t.result_meta_xdr, 'base64');
  const sw = meta.switch();
  let evs = [];
  let ver = sw;
  if (sw === 4) evs = meta.v4().operations().flatMap(o => o.events()), console.log('v4 tx-level events', meta.v4().events().length);
  else if (sw === 3) evs = (meta.v3().sorobanMeta()?.events() || []).map(e=>e);
  console.log(t.ledger, t.hash.slice(0,10), 'src', t.source_account.slice(0,6), 'ok', t.successful, 'meta v'+ver, 'events', evs.length, 'ops', t.operation_count);
}
