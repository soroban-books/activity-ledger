/**
 * Soroswap router swap event (mainnet sample, ledger 65021724):
 *   topics ["SoroswapRouter","swap"]  data { amounts: [in, ..., out], path: [tokenIn, ..., tokenOut], to }
 * When `to` is the account the trade is exact: input = amounts[0] of path[0], output = last of each.
 * Router-mediated swaps where `to` is another contract fall through to the generic classifier.
 */
import type { LedgerEvent } from '../types.ts';
import { baseEvent, claimFlow, type ClassifyCtx } from './ctx.ts';

export function decodeSoroswap(ctx: ClassifyCtx): LedgerEvent[] {
  const out: LedgerEvent[] = [];
  for (const e of ctx.tx.events) {
    if (e.type !== 'contract' || e.topics[0] !== 'SoroswapRouter' || e.topics[1] !== 'swap') continue;
    const d = e.data as { amounts?: unknown[]; path?: unknown[]; to?: unknown } | null;
    if (!d || !Array.isArray(d.amounts) || !Array.isArray(d.path) || d.to !== ctx.account) continue;
    const a0 = d.amounts[0];
    const aN = d.amounts[d.amounts.length - 1];
    const p0 = d.path[0];
    const pN = d.path[d.path.length - 1];
    if (typeof a0 !== 'bigint' || typeof aN !== 'bigint' || typeof p0 !== 'string' || typeof pN !== 'string') continue;
    const assetIn = ctx.reg.canonical(p0);
    const assetOut = ctx.reg.canonical(pN);
    claimFlow(ctx, (f) => f.kind === 'transfer' && f.from === ctx.account && f.asset === assetIn && f.amount === a0);
    claimFlow(ctx, (f) => f.kind === 'transfer' && f.to === ctx.account && f.asset === assetOut && f.amount === aN);
    out.push(baseEvent(ctx, {
      kind: 'trade', protocol: 'soroswap', confidence: 'exact', counterparty: e.contractId,
      legs: [
        { direction: 'out', asset: assetIn, amount: a0, decimals: ctx.reg.decimalsOf(assetIn) },
        { direction: 'in', asset: assetOut, amount: aN, decimals: ctx.reg.decimalsOf(assetOut) },
      ],
      note: `Soroswap swap over ${d.path.length - 1} hop(s)`,
    }));
  }
  return out;
}

/** True when any Soroswap router/pair event is present (used to tag generic LP/swap events). */
export const hasSoroswap = (ctx: ClassifyCtx): boolean =>
  ctx.tx.events.some((e) => e.topics[0] === 'SoroswapRouter' || e.topics[0] === 'SoroswapPair');
