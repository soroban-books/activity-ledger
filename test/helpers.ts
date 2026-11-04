import fs from 'node:fs';
import type { RawTx, LedgerEvent } from '../src/types.ts';
import type { PriceProvider } from '../src/pricing/types.ts';
import { parseFixture } from '../src/util.ts';
import { AssetRegistry } from '../src/assets.ts';
import { classifyTx } from '../src/classify/index.ts';

export const loadFixture = (name: string): RawTx[] =>
  parseFixture<RawTx[]>(fs.readFileSync(new URL(`../fixtures/${name}.json`, import.meta.url), 'utf8'));

export const USDC = 'USDC:GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN';
export const BLND = 'BLND:GDJEHTBE6ZHUXSWFI642DCGLUOECLHPF3KSXHPXTSTJ7E3JF6MQ5EZYY';

/** Fixed-price provider: USDC = $1, native = $0.20, BLND = $0.006, others unknown. */
export const fixedPrices: PriceProvider = {
  async price(asset) {
    const m: Record<string, bigint> = { [USDC]: 1_000_000n, native: 200_000n, [BLND]: 6_000n };
    return m[asset] === undefined ? null : { micro: m[asset]!, source: 'test' };
  },
};

export function classifyAll(txs: RawTx[], account: string): LedgerEvent[] {
  const reg = new AssetRegistry();
  return txs.flatMap((tx) => classifyTx(tx, account, reg));
}
