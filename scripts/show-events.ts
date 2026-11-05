/** Dump the raw contract events of one fixture tx: node scripts/show-events.ts <fixture> <hash-prefix> */
import fs from 'node:fs';
import { parseFixture, jsonSafe } from '../src/util.ts';
import type { RawTx } from '../src/types.ts';
const [name, prefix] = process.argv.slice(2);
const txs = parseFixture<RawTx[]>(fs.readFileSync(`fixtures/${name}.json`, 'utf8'));
const tx = txs.find((t) => t.hash.startsWith(prefix!))!;
console.log('ops', tx.opTypes, 'fns', tx.invokedFunctions, 'src', tx.sourceAccount.slice(0, 8));
for (const e of tx.events) console.log(String(e.eventIndex).padStart(2), (e.contractId ?? '-').slice(0, 6), jsonSafe(e.topics).slice(0, 150), jsonSafe(e.data).slice(0, 200));
