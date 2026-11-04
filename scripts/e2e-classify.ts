import { AssetRegistry } from '../src/assets.ts';
import { classifyTx } from '../src/classify/index.ts';
import { syncAccount } from '../src/sync.ts';
import { jsonSafe } from '../src/util.ts';
const account = process.argv[2]!;
const reg = new AssetRegistry();
const r = await syncAccount(account, {
  limit: Number(process.argv[3] ?? 15),
  onSkip: (h, why) => console.log('SKIP', h.hash.slice(0, 8), why),
  onTx: (tx) => {
    for (const e of classifyTx(tx, account, reg))
      console.log(tx.closedAt, tx.hash.slice(0, 8), e.kind.padEnd(14), (e.protocol ?? '-').padEnd(8), e.confidence.padEnd(9),
        e.legs.map((l) => `${l.direction}:${l.amount}:${l.asset.split(':')[0]}`).join(' '), '|', e.note);
  },
});
console.log(jsonSafe(r));
