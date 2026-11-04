import fs from 'node:fs';
import type { RawTx } from '../src/types.ts';
import { AssetRegistry } from '../src/assets.ts';
import { classifyTx } from '../src/classify/index.ts';
import { parseFixture } from '../src/util.ts';
const [name, account] = process.argv.slice(2);
const txs = parseFixture<RawTx[]>(fs.readFileSync(`fixtures/${name}.json`, 'utf8'));
const reg = new AssetRegistry();
for (const tx of txs) for (const e of classifyTx(tx, account!, reg))
  console.log(tx.closedAt, tx.hash.slice(0, 8), e.kind.padEnd(14), (e.protocol ?? '-').padEnd(8), e.confidence.padEnd(9), e.legs.map((l) => `${l.direction}:${l.amount}:${l.asset.split(':')[0]}`).join(' '), e.position ? `| shares ${e.position.direction} ${e.position.shares}` : '', '|', e.note);
