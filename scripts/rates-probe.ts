/** Which implied Blend rates (tokens/shares) exist in a fixture, and which assets do its auctions need? node scripts/rates-probe.ts <fixture> */
import fs from 'node:fs';
import { parseFixture } from '../src/util.ts';
import type { RawTx } from '../src/types.ts';
const txs = parseFixture<RawTx[]>(fs.readFileSync(`fixtures/${process.argv[2]}.json`, 'utf8'));
const short = (a: unknown): string => String(a).slice(0, 6);
for (const tx of txs) {
  for (const e of tx.events) {
    const n = e.topics[0];
    if (['supply', 'supply_collateral', 'withdraw', 'withdraw_collateral', 'borrow', 'repay'].includes(n as string) && Array.isArray(e.data)) {
      const side = n === 'borrow' || n === 'repay' ? 'd' : 'b';
      const [t, s] = e.data as bigint[];
      console.log(`L${tx.ledger} ${tx.hash.slice(0, 6)} ${side}_rate ${short(e.contractId)}/${short(e.topics[1])} = ${(Number(t) / Number(s)).toFixed(8)}  (tokens ${t}, shares ${s})`);
    }
    if (n === 'fill_auction' || n === 'new_auction') {
      const ad: any = (e.data as any[])[n === 'fill_auction' ? 2 : 1];
      console.log(`L${tx.ledger} ${tx.hash.slice(0, 6)} ${n} bid=${Object.keys(ad.bid).map(short)} lot=${Object.keys(ad.lot).map(short)}`);
    }
  }
}
