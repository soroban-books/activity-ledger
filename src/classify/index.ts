import type { LedgerEvent, RawTx } from '../types.ts';
import type { AssetRegistry } from '../assets.ts';
import { extractFlows, netFee } from './flows.ts';
import { baseEvent, type ClassifyCtx } from './ctx.ts';
import { decodeBlend } from './blend.ts';
import { decodeSoroswap } from './soroswap.ts';
import { classifyGeneric } from './generic.ts';

/**
 * Classify one transaction from the point of view of `account`.
 * Order: protocol decoders (exact) -> generic flow heuristic -> fee -> unclassified marker.
 */
export function classifyTx(tx: RawTx, account: string, reg: AssetRegistry): LedgerEvent[] {
  reg.learn(tx.events);
  let n = 0;
  const ctx: ClassifyCtx = {
    tx,
    account,
    reg,
    flows: tx.successful ? extractFlows(tx, reg) : [],
    claimed: new Set(),
    next: () => `${tx.hash}:${n++}`,
  };
  const events: LedgerEvent[] = [];
  if (tx.successful) {
    events.push(...decodeBlend(ctx), ...decodeSoroswap(ctx), ...classifyGeneric(ctx));
  }
  const fee = netFee(tx.events, account);
  if (fee > 0n) {
    events.push(baseEvent(ctx, {
      kind: 'fee', protocol: null, confidence: 'exact',
      legs: [{ direction: 'out', asset: 'native', amount: fee, decimals: 7 }],
      note: tx.successful ? 'network fee' : 'network fee (failed transaction)',
    }));
  }
  // Only flag contract calls the account actually made (source or fee payer), never bystanders.
  const participant = tx.sourceAccount === account || tx.feeAccount === account;
  if (participant && events.every((e) => e.kind === 'fee') && tx.successful && tx.invokedContracts.length > 0) {
    events.push(baseEvent(ctx, {
      kind: 'unclassified', protocol: null, confidence: 'unknown', legs: [],
      counterparty: tx.invokedContracts[0] ?? null,
      note: `contract call ${tx.invokedFunctions[0] ?? '?'} with no asset movement for this account`,
    }));
  }
  return events;
}
