/**
 * Historical Blend exchange rates, derived from the pool's own events.
 *
 * b_rate (b-tokens -> underlying) and d_rate (d-tokens -> underlying) are pool state that public
 * RPC only serves for the current ledger. But every supply/withdraw event states
 * [tokens, b_tokens] and every borrow/repay event states [tokens, d_tokens], so tokens / shares IS
 * the rate at that ledger. Verified on mainnet: four USDC repays across 180 ledgers gave
 * 1.24961788, 1.24961819, 1.24962129, 1.24962137, monotonic and accurate to about 1e-7.
 * Observations come from every transaction already in the database, including other users'
 * events inside those transactions (a liquidator's repay prices the victim's debt).
 */
import type { RawTx } from '../types.ts';
import type { AssetRegistry } from '../assets.ts';
import type { BlendDirectory } from './directory.ts';

/** Blend stores rates with 12 decimals (SCALAR_12). */
export const RATE_SCALE = 10n ** 12n;
/** Ignore tiny amounts: rounding of 1 unit in 10^6 would already cost 1e-6 of accuracy. */
const MIN_UNITS = 1_000_000n;
/** About 3 days of ledgers: interest drift over that span is small; beyond it we refuse to guess. */
export const DEFAULT_MAX_LEDGERS = 51_840;

export type RateSide = 'b' | 'd';
export interface RateHit {
  rate12: bigint;
  /** Ledger the observation came from. */
  ledger: number;
  /** Distance in ledgers from the requested ledger (0 = same ledger). */
  distance: number;
}

const B_EVENTS = new Set(['supply', 'supply_collateral', 'withdraw', 'withdraw_collateral']);
const D_EVENTS = new Set(['borrow', 'repay', 'flash_loan']);

export class RateBook {
  private obs = new Map<string, { ledger: number; rate12: bigint }[]>();
  private sorted = true;
  private static key = (pool: string, asset: string, side: RateSide): string => `${pool}|${asset}|${side}`;

  add(pool: string, asset: string, side: RateSide, ledger: number, tokens: bigint, shares: bigint): void {
    if (tokens < MIN_UNITS || shares < MIN_UNITS) return;
    const k = RateBook.key(pool, asset, side);
    const list = this.obs.get(k) ?? [];
    list.push({ ledger, rate12: (tokens * RATE_SCALE + shares / 2n) / shares });
    this.obs.set(k, list);
    this.sorted = false;
  }

  get size(): number {
    let n = 0;
    for (const l of this.obs.values()) n += l.length;
    return n;
  }

  /** Nearest observation to `ledger`, or null if none within `maxLedgers`. */
  lookup(pool: string, asset: string, side: RateSide, ledger: number, maxLedgers = DEFAULT_MAX_LEDGERS): RateHit | null {
    const list = this.obs.get(RateBook.key(pool, asset, side));
    if (!list || list.length === 0) return null;
    if (!this.sorted) {
      for (const l of this.obs.values()) l.sort((a, b) => a.ledger - b.ledger);
      this.sorted = true;
    }
    let lo = 0;
    let hi = list.length - 1;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (list[mid]!.ledger < ledger) lo = mid + 1;
      else hi = mid;
    }
    let best = list[lo]!;
    const before = list[lo - 1];
    if (before && Math.abs(before.ledger - ledger) < Math.abs(best.ledger - ledger)) best = before;
    const distance = Math.abs(best.ledger - ledger);
    return distance > maxLedgers ? null : { rate12: best.rate12, ledger: best.ledger, distance };
  }

  /** Collect observations from every successful transaction, for verified pools only. */
  static harvest(txs: Iterable<RawTx>, dir: BlendDirectory, reg: AssetRegistry): RateBook {
    const book = new RateBook();
    for (const tx of txs) {
      if (!tx.successful) continue;
      for (const e of tx.events) {
        const name = e.topics[0];
        if (e.type !== 'contract' || typeof name !== 'string' || !e.contractId || !dir.isPool(e.contractId)) continue;
        const side: RateSide | null = B_EVENTS.has(name) ? 'b' : D_EVENTS.has(name) ? 'd' : null;
        if (!side || typeof e.topics[1] !== 'string' || !Array.isArray(e.data)) continue;
        const [tokens, shares] = e.data as unknown[];
        if (typeof tokens !== 'bigint' || typeof shares !== 'bigint') continue;
        book.add(e.contractId, reg.canonical(e.topics[1]), side, tx.ledger, tokens, shares);
      }
    }
    return book;
  }
}
