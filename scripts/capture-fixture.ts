/** Capture real mainnet transactions as RawTx fixtures: capture-fixture.ts <name> <hash> [<hash>...] */
import fs from 'node:fs';
import type { RawTx } from '../src/types.ts';
import { LakeSource } from '../src/sources/lake.ts';
import { parseEnvelope } from '../src/sources/horizon.ts';
import { stringifyFixture } from '../src/util.ts';
import { httpFetch } from '../src/sources/net.ts';
const [name, ...hashes] = process.argv.slice(2);
const lake = new LakeSource({ cacheDir: '.cache/lake' });
const out: RawTx[] = [];
for (const hash of hashes) {
  const h: any = await (await httpFetch(`https://horizon.stellar.org/transactions/${hash}`)).json();
  const L = await lake.getLedger(h.ledger);
  const t = L.txs.get(hash)!;
  out.push({
    ledger: h.ledger, closedAt: L.closedAt, hash, applicationOrder: t.applicationOrder,
    sourceAccount: h.source_account, feeAccount: h.fee_account, successful: h.successful,
    feeCharged: BigInt(h.fee_charged), ...parseEnvelope(h.envelope_xdr), events: t.events,
  });
}
out.sort((a, b) => a.ledger - b.ledger || a.applicationOrder - b.applicationOrder);
fs.mkdirSync('fixtures', { recursive: true });
fs.writeFileSync(`fixtures/${name}.json`, stringifyFixture(out));
console.log(name, out.length, 'txs', out.map((t) => `${t.ledger}:${t.hash.slice(0, 8)}:${t.invokedFunctions.join(',')}`).join(' '));
