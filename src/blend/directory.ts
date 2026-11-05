/**
 * Which contracts are really Blend? A decoder must never trust event shape alone: on mainnet a
 * contract that is not a Blend pool emitted 170 `flash_loan` events in the exact Blend shape
 * (verified 2026-11-04 against the factory storage). Pools are accepted only if
 *   1. they are in the built-in seed list (known mainnet pools), or
 *   2. a Blend pool factory deployed them (checked once through RPC, then cached).
 * The backstop is a singleton per Blend version.
 */
import type { RawTx } from '../types.ts';
import { deployedByBlendFactory } from './factory.ts';

export const SEED_POOLS = [
  'CAJJZSGMMM3PD7N33TAPHGBUGTB43OC73HVIK2L2G6BNGGGYOSSYBXBD', // FixedV2
  'CCCCIQSDILITHMM7PBSLVDT5MISSY7R26MNZXCX4H7J5JQ5FPIYOGYFS', // YieldBloxV2
  'CDVQVKOY2YSXS2IC7KN6MNASSHPAO7UN2UR2ON4OI2SKMFJNVAMDX6DP', // Fixed (v1)
  'CBP7NO6F7FRDHSOFQBT2L2UWYIZ2PU76JKVRYAQTG3KZSQLYAOKIF2WB', // YieldBlox (v1)
];
export const BACKSTOPS = [
  'CAQQR5SWBXKIGZKPBZDH3KM5GQ5GUTPKB7JAFCINLZBC5WXPJKRG3IM7', // v2
  'CAO3AGAMZVRMHITL36EJ2VZQWKYRPWMQAPDQD5YEOF3GIF7T44U4JAL3', // v1
];

/** Event names that make a contract a *candidate* pool (not proof). */
export const POOL_EVENT_NAMES = new Set([
  'supply', 'supply_collateral', 'withdraw', 'withdraw_collateral', 'borrow', 'repay', 'flash_loan',
  'claim', 'new_auction', 'fill_auction', 'delete_auction', 'bad_debt', 'defaulted_debt', 'gulp',
]);

export interface VerdictCache {
  blendVerdict(contract: string): { verdict: 'pool' | 'no'; checkedAt: string } | undefined;
  setBlendVerdict(contract: string, verdict: 'pool' | 'no'): void;
}

export class BlendDirectory {
  readonly pools = new Set<string>();
  readonly backstops = new Set<string>();
  /** Candidates whose verification failed (RPC unreachable): neither accepted nor proven foreign. */
  readonly unverified = new Set<string>();
  readonly rejected = new Set<string>();

  static seeded(extraPools: Iterable<string> = []): BlendDirectory {
    const d = new BlendDirectory();
    for (const p of [...SEED_POOLS, ...extraPools]) d.pools.add(p);
    for (const b of BACKSTOPS) d.backstops.add(b);
    return d;
  }
  isPool = (id: string | null): boolean => id !== null && this.pools.has(id);
  isBackstop = (id: string | null): boolean => id !== null && this.backstops.has(id);
}

/** Contracts in these transactions that emit Blend-shaped events and are not yet known either way. */
export function candidateContracts(txs: Iterable<RawTx>, dir: BlendDirectory): Set<string> {
  const out = new Set<string>();
  for (const tx of txs) {
    for (const e of tx.events) {
      if (e.type !== 'contract' || !e.contractId || typeof e.topics[0] !== 'string') continue;
      if (!POOL_EVENT_NAMES.has(e.topics[0]) || dir.isPool(e.contractId) || dir.isBackstop(e.contractId)) continue;
      out.add(e.contractId);
    }
  }
  return out;
}

const DAY = 86_400_000;

/** Verify candidates through the factory; positives are cached forever, negatives for a day. */
export async function resolveBlend(
  dir: BlendDirectory,
  candidates: Iterable<string>,
  opts: { cache?: VerdictCache; lookup?: (id: string) => Promise<boolean>; now?: number } = {},
): Promise<void> {
  const lookup = opts.lookup ?? deployedByBlendFactory;
  const now = opts.now ?? Date.now();
  for (const id of candidates) {
    const cached = opts.cache?.blendVerdict(id);
    if (cached?.verdict === 'pool') {
      dir.pools.add(id);
      continue;
    }
    if (cached?.verdict === 'no' && now - Date.parse(cached.checkedAt) < DAY) {
      dir.rejected.add(id);
      continue;
    }
    try {
      if (await lookup(id)) {
        dir.pools.add(id);
        opts.cache?.setBlendVerdict(id, 'pool');
      } else {
        dir.rejected.add(id);
        opts.cache?.setBlendVerdict(id, 'no');
      }
    } catch {
      dir.unverified.add(id); // never cache a failed lookup
    }
  }
}
