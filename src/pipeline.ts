import type { LedgerEvent, RawTx } from './types.ts';
import { AssetRegistry } from './assets.ts';
import { classifyTx } from './classify/index.ts';
import { Engine, byChronology, DEFAULT_POLICY, type EngineResult, type Policy } from './ledger/engine.ts';
import type { PriceProvider } from './pricing/types.ts';
import { BlendDirectory, candidateContracts, resolveBlend, type VerdictCache } from './blend/directory.ts';

/**
 * Decide which Blend-looking contracts in these transactions are real Blend pools. Seed pools are
 * accepted offline; unknown ones are checked once against the Blend pool factory through RPC and
 * the verdict is cached. If RPC is unreachable they stay `unverified` (reported, not decoded).
 */
export async function prepareBlend(
  perAccount: Map<string, RawTx[]>,
  cache?: VerdictCache,
  lookup?: (id: string) => Promise<boolean>,
): Promise<BlendDirectory> {
  const dir = BlendDirectory.seeded();
  const all = [...perAccount.values()].flat();
  await resolveBlend(dir, candidateContracts(all, dir), { cache, lookup });
  return dir;
}

/** Classify the stored transactions of several accounts and replay them through the engine. */
export async function buildLedger(
  perAccount: Map<string, RawTx[]>,
  prices: PriceProvider,
  policyOverrides: Partial<Policy> = {},
  blend: BlendDirectory = BlendDirectory.seeded(),
): Promise<{ events: LedgerEvent[]; result: EngineResult; registry: AssetRegistry }> {
  const reg = new AssetRegistry();
  const policy: Policy = {
    ...DEFAULT_POLICY,
    ...policyOverrides,
    ownAddresses: new Set([...perAccount.keys(), ...(policyOverrides.ownAddresses ?? [])]),
  };
  // Learn SAC mappings from every transaction first so decoders can resolve contract ids.
  for (const txs of perAccount.values()) for (const tx of txs) reg.learn(tx.events);
  const events: LedgerEvent[] = [];
  for (const [account, txs] of perAccount) {
    for (const tx of txs) events.push(...classifyTx(tx, account, reg, blend));
  }
  events.sort(byChronology);
  const engine = new Engine(prices, policy);
  for (const ev of events) await engine.apply(ev);
  const result = engine.result();

  // Contracts that look like Blend but could not be checked: say so instead of silently dropping them.
  if (blend.unverified.size > 0) {
    const seen = new Set<string>();
    for (const txs of perAccount.values()) {
      for (const tx of txs) {
        for (const e of tx.events) {
          if (e.contractId && blend.unverified.has(e.contractId) && !seen.has(e.contractId)) {
            seen.add(e.contractId);
            result.warnings.push({
              eventId: `${tx.hash}:0`,
              code: 'unclassified',
              message: `Contract ${e.contractId} emits Blend-shaped events but could not be verified as a Blend pool (Soroban RPC unreachable). It is treated as a generic contract. Run again with network access.`,
            });
          }
        }
      }
    }
  }
  return { events, result, registry: reg };
}
