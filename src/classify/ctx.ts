import type { RawTx, LedgerEvent } from '../types.ts';
import type { AssetRegistry } from '../assets.ts';
import type { Flow } from './flows.ts';
import type { BlendDirectory } from '../blend/directory.ts';

export interface ClassifyCtx {
  tx: RawTx;
  account: string;
  reg: AssetRegistry;
  /** Which contracts are really Blend (verified pools and backstops). */
  blend: BlendDirectory;
  flows: Flow[];
  /** eventIndex of flows already explained by a protocol decoder. */
  claimed: Set<number>;
  next: () => string;
}

export type Decoder = (ctx: ClassifyCtx) => LedgerEvent[];

/** Find an unclaimed flow matching a predicate and mark it claimed. */
export function claimFlow(ctx: ClassifyCtx, pred: (f: Flow) => boolean): Flow | undefined {
  const f = ctx.flows.find((x) => !ctx.claimed.has(x.eventIndex) && pred(x));
  if (f) ctx.claimed.add(f.eventIndex);
  return f;
}

export function baseEvent(
  ctx: ClassifyCtx,
  partial: Pick<LedgerEvent, 'kind' | 'protocol' | 'legs' | 'note' | 'confidence'> & Partial<LedgerEvent>,
): LedgerEvent {
  return {
    id: ctx.next(),
    txHash: ctx.tx.hash,
    ledger: ctx.tx.ledger,
    closedAt: ctx.tx.closedAt,
    txOrder: ctx.tx.applicationOrder,
    counterparty: null,
    ...partial,
  };
}
