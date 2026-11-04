/**
 * Blend v2 pool events (blend-capital/blend-contracts-v2 pool/src/events.rs; shapes confirmed on
 * mainnet ledger 65029187 and in an RPC sample of FixedV2/YieldBloxV2 events):
 *   supply / supply_collateral     topics [name, asset, from]  data [tokens_in,  b_tokens_minted]
 *   withdraw / withdraw_collateral topics [name, asset, from]  data [tokens_out, b_tokens_burnt]
 *   borrow                         topics [name, asset, from]  data [tokens_out, d_tokens_minted]
 *   repay                          topics [name, asset, from]  data [tokens_in,  d_tokens_burnt]
 *   claim                          topics [name, from]         data [reserve_token_ids, amount_claimed]
 * Interest is NOT an event. For realised interest it is derived at withdrawal from the share
 * ledger (see ledger/positions.ts): income = tokens_out - principal attributable to burnt shares.
 */
import type { LedgerEvent } from '../types.ts';
import { baseEvent, claimFlow, type ClassifyCtx } from './ctx.ts';

const SUPPLY = new Set(['supply', 'supply_collateral']);
const WITHDRAW = new Set(['withdraw', 'withdraw_collateral']);

const big = (v: unknown): bigint | null => (typeof v === 'bigint' ? v : null);

export function decodeBlend(ctx: ClassifyCtx): LedgerEvent[] {
  const out: LedgerEvent[] = [];
  for (const e of ctx.tx.events) {
    if (e.type !== 'contract' || !e.contractId) continue;
    const name = e.topics[0];
    if (typeof name !== 'string') continue;
    const pool = e.contractId;

    if ((SUPPLY.has(name) || WITHDRAW.has(name) || name === 'borrow' || name === 'repay') && e.topics.length === 3) {
      if (e.topics[2] !== ctx.account || typeof e.topics[1] !== 'string') continue;
      if (!Array.isArray(e.data) || e.data.length < 2) continue;
      const tokens = big(e.data[0]);
      const shares = big(e.data[1]);
      if (tokens === null || shares === null) continue;
      const asset = ctx.reg.canonical(e.topics[1]);
      const dec = ctx.reg.decimalsOf(asset);
      const inbound = WITHDRAW.has(name) || name === 'borrow';
      // The pool moves the underlying with a SAC/SEP-41 transfer; mark it explained.
      claimFlow(ctx, (f) =>
        f.kind === 'transfer' &&
        f.asset === asset &&
        f.amount === tokens &&
        (inbound ? f.to === ctx.account : f.from === ctx.account),
      );
      if (SUPPLY.has(name)) {
        out.push(baseEvent(ctx, {
          kind: 'lend_supply', protocol: 'blend', confidence: 'exact', counterparty: pool,
          legs: [{ direction: 'out', asset, amount: tokens, decimals: dec }],
          position: { protocol: 'blend', pool, asset, shares, direction: 'in' },
          note: `Blend ${name} ${shares} b-tokens`,
        }));
      } else if (WITHDRAW.has(name)) {
        out.push(baseEvent(ctx, {
          kind: 'lend_withdraw', protocol: 'blend', confidence: 'exact', counterparty: pool,
          legs: [{ direction: 'in', asset, amount: tokens, decimals: dec }],
          position: { protocol: 'blend', pool, asset, shares, direction: 'out' },
          note: `Blend ${name} burning ${shares} b-tokens`,
        }));
      } else if (name === 'borrow') {
        out.push(baseEvent(ctx, {
          kind: 'borrow', protocol: 'blend', confidence: 'exact', counterparty: pool,
          legs: [{ direction: 'in', asset, amount: tokens, decimals: dec }],
          note: `Blend borrow, ${shares} d-tokens`,
        }));
      } else {
        out.push(baseEvent(ctx, {
          kind: 'repay', protocol: 'blend', confidence: 'exact', counterparty: pool,
          legs: [{ direction: 'out', asset, amount: tokens, decimals: dec }],
          note: `Blend repay, ${shares} d-tokens burnt`,
        }));
      }
    } else if (name === 'claim' && e.topics.length === 2 && e.topics[1] === ctx.account) {
      if (!Array.isArray(e.data) || e.data.length < 2) continue;
      const amount = big(e.data[1]);
      if (amount === null) continue;
      // The claim event does not name the emission asset; it is the pool's reward token, found
      // through the matching inbound transfer to the account.
      const f = claimFlow(ctx, (x) => x.kind === 'transfer' && x.to === ctx.account && x.amount === amount);
      if (!f) continue;
      out.push(baseEvent(ctx, {
        kind: 'reward_claim', protocol: 'blend', confidence: 'exact', counterparty: pool,
        legs: [{ direction: 'in', asset: f.asset, amount, decimals: ctx.reg.decimalsOf(f.asset) }],
        note: 'Blend emissions claim',
      }));
    }
  }
  return out;
}
