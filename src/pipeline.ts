import type { LedgerEvent, RawTx } from './types.ts';
import { AssetRegistry } from './assets.ts';
import { classifyTx } from './classify/index.ts';
import { Engine, byChronology, DEFAULT_POLICY, type EngineResult, type Policy } from './ledger/engine.ts';
import type { PriceProvider } from './pricing/types.ts';

/** Classify the stored transactions of several accounts and replay them through the engine. */
export async function buildLedger(
  perAccount: Map<string, RawTx[]>,
  prices: PriceProvider,
  policyOverrides: Partial<Policy> = {},
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
    for (const tx of txs) events.push(...classifyTx(tx, account, reg));
  }
  events.sort(byChronology);
  const engine = new Engine(prices, policy);
  for (const ev of events) await engine.apply(ev);
  return { events, result: engine.result(), registry: reg };
}
