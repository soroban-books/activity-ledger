/**
 * Generic classifier over CAP-67 flows that no protocol decoder explained. Works for any
 * protocol, with 'heuristic' confidence:
 *   out >=1 asset + minted share in   -> lp_add (>=2 out) or vault_deposit (1 out)
 *   burned share out + in >=1 asset   -> lp_remove (>=2 in) or vault_withdraw (1 in)
 *   out and in of different assets    -> trade
 *   only out / only in                -> transfer_out / transfer_in
 */
import type { Leg, LedgerEvent } from '../types.ts';
import type { Flow } from './flows.ts';
import { baseEvent, type ClassifyCtx } from './ctx.ts';
import { hasSoroswap } from './soroswap.ts';

const sumByAsset = (flows: Flow[], reg: ClassifyCtx['reg']): Leg[] => {
  const m = new Map<string, bigint>();
  for (const f of flows) m.set(f.asset, (m.get(f.asset) ?? 0n) + f.amount);
  return [...m].map(([asset, amount]) => ({ direction: 'in' as const, asset, amount, decimals: reg.decimalsOf(asset) }));
};

export function classifyGeneric(ctx: ClassifyCtx): LedgerEvent[] {
  const mine = ctx.flows.filter(
    (f) => !ctx.claimed.has(f.eventIndex) && (f.to === ctx.account || f.from === ctx.account) && f.from !== f.to,
  );
  if (mine.length === 0) return [];
  const proto = hasSoroswap(ctx) ? 'soroswap' : 'generic';

  const minted = mine.filter((f) => f.kind === 'mint' && f.to === ctx.account);
  const burned = mine.filter((f) => f.kind === 'burn' && f.from === ctx.account);
  const ins = mine.filter((f) => f.to === ctx.account && f.kind !== 'mint');
  const outs = mine.filter((f) => f.from === ctx.account && f.kind !== 'burn');

  const legsOf = (dir: 'in' | 'out', fl: Flow[]): Leg[] =>
    sumByAsset(fl, ctx.reg).map((l) => ({ ...l, direction: dir }));

  // Liquidity / vault shares are tokens minted to or burned from the account.
  if (minted.length && outs.length) {
    return [baseEvent(ctx, {
      kind: outs.length >= 2 ? 'lp_add' : 'vault_deposit', protocol: proto, confidence: 'heuristic',
      legs: [...legsOf('out', outs), ...legsOf('in', minted)],
      note: 'Assets sent, share token minted to account',
    })];
  }
  if (burned.length && ins.length) {
    return [baseEvent(ctx, {
      kind: ins.length >= 2 ? 'lp_remove' : 'vault_withdraw', protocol: proto, confidence: 'heuristic',
      legs: [...legsOf('out', burned), ...legsOf('in', ins)],
      note: 'Share token burned, assets received',
    })];
  }

  // Net per asset: a payment plus its refund must not look like a trade.
  const net = new Map<string, bigint>();
  for (const f of mine) {
    const sign = f.to === ctx.account ? 1n : -1n;
    net.set(f.asset, (net.get(f.asset) ?? 0n) + sign * f.amount);
  }
  const pos = [...net].filter(([, v]) => v > 0n);
  const neg = [...net].filter(([, v]) => v < 0n);
  if (pos.length && neg.length) {
    const legs: Leg[] = [
      ...neg.map(([asset, v]) => ({ direction: 'out' as const, asset, amount: -v, decimals: ctx.reg.decimalsOf(asset) })),
      ...pos.map(([asset, v]) => ({ direction: 'in' as const, asset, amount: v, decimals: ctx.reg.decimalsOf(asset) })),
    ];
    return [baseEvent(ctx, { kind: 'trade', protocol: proto, confidence: 'heuristic', legs, note: 'Asset(s) out, different asset(s) in within one transaction' })];
  }

  // Plain transfers, one event per movement so counterparties and memos survive.
  const evs: LedgerEvent[] = [];
  for (const f of mine) {
    const inbound = f.to === ctx.account;
    evs.push(baseEvent(ctx, {
      kind: f.kind === 'mint' ? 'mint' : f.kind === 'burn' ? 'burn' : inbound ? 'transfer_in' : 'transfer_out',
      protocol: null, confidence: 'exact',
      counterparty: inbound ? f.from : f.to,
      legs: [{ direction: inbound ? 'in' : 'out', asset: f.asset, amount: f.amount, decimals: ctx.reg.decimalsOf(f.asset) }],
      note: f.muxedId ? `memo/muxed id ${f.muxedId}` : '',
    }));
  }
  return evs;
}
