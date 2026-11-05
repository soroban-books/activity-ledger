/**
 * Blend v2 decoder (blend-capital/blend-contracts-v2: pool/src/events.rs, backstop/src/events.rs).
 * Only contracts the BlendDirectory accepts are decoded (seed list or factory-verified), because
 * event shape alone is not proof. Interest is never an event; it is derived from share ledgers
 * (ledger/positions.ts for b-tokens and backstop shares, ledger/debt.ts for d-tokens).
 *
 * POOL (topics [name, ...], data):
 *   supply|supply_collateral      [asset, from]             [tokens_in, b_minted]     -> lend_supply
 *   withdraw|withdraw_collateral  [asset, from]             [tokens_out, b_burnt]     -> lend_withdraw
 *   borrow                        [asset, from]             [tokens_out, d_minted]    -> borrow
 *   repay                         [asset, from]             [tokens_in, d_burnt]      -> repay
 *   flash_loan                    [asset, from, contract]   [tokens_out, d_minted]    -> borrow, no wallet cash
 *   claim                         [from]                    [reserve_ids, amount]     -> reward_claim
 *   bad_debt                      [user, asset]             d_tokens                  -> liquidation (debt written off)
 *   new_auction|delete_auction    [type, user]              [percent, AuctionData] | () -> no_op notice
 *   fill_auction                  [type, user]              [filler, percent, AuctionData] -> liquidation (type 0)
 * BACKSTOP:
 *   deposit            [pool, from]  [tokens_in, shares_minted]   -> lend_supply (protocol blend-backstop)
 *   withdraw           [pool, from]  [shares_burnt, tokens_out]   -> lend_withdraw (note: shares first)
 *   queue_withdrawal   [pool, from]  [shares, expiration]         -> no_op
 *   dequeue_withdrawal [pool, from]  shares                       -> no_op
 *   claim              [from]        lp_tokens_minted             -> reward_claim
 *
 * `from` is the owner of the position, NOT necessarily the wallet that paid or received the
 * tokens (submit has separate spender and to). A cash leg is booked only when a matching CAP-67
 * transfer really touches this account; otherwise the event is surfaced as `unclassified` rather
 * than inventing a wallet movement.
 */
import type { LedgerEvent, PositionChange } from '../types.ts';
import { baseEvent, claimFlow, type ClassifyCtx } from './ctx.ts';

const SUPPLY = new Set(['supply', 'supply_collateral']);
const WITHDRAW = new Set(['withdraw', 'withdraw_collateral']);
const AUCTION_TYPES = ['user liquidation', 'bad debt auction', 'interest auction'];

const big = (v: unknown): bigint | null => (typeof v === 'bigint' ? v : null);
const str = (v: unknown): string | null => (typeof v === 'string' ? v : null);

/** AuctionData maps ({asset: amount}) as produced by scValToNative. */
function amountMap(v: unknown): [string, bigint][] | null {
  if (!v || typeof v !== 'object') return null;
  const out: [string, bigint][] = [];
  for (const [k, a] of Object.entries(v as Record<string, unknown>)) {
    const n = big(a);
    if (n === null) return null;
    out.push([k, n]);
  }
  return out;
}

export function decodeBlend(ctx: ClassifyCtx): LedgerEvent[] {
  const out: LedgerEvent[] = [];
  const unmatched = new Set<string>(); // Blend events in this tx that are not about this account
  const acct = ctx.account;

  const behalf = (pool: string, what: string): LedgerEvent =>
    baseEvent(ctx, {
      kind: 'unclassified', protocol: 'blend', confidence: 'exact', counterparty: pool, legs: [],
      note: `Blend ${what} for this account's position, but the tokens moved between other addresses (spender or receiver is not this account), so no wallet movement is booked`,
    });
  const pos = (protocol: string, pool: string, asset: string, shares: bigint, direction: 'in' | 'out', tokens?: bigint): PositionChange => ({
    protocol, pool, asset, shares, direction, ...(tokens === undefined ? {} : { tokens }),
  });

  for (const e of ctx.tx.events) {
    if (e.type !== 'contract' || !e.contractId) continue;
    const name = e.topics[0];
    if (typeof name !== 'string') continue;
    const id = e.contractId;
    const isPool = ctx.blend.isPool(id);
    const isBackstop = !isPool && ctx.blend.isBackstop(id);
    if (!isPool && !isBackstop) continue;
    const t = e.topics;
    const d = e.data;

    // ------------------------------------------------------------------ BACKSTOP
    if (isBackstop) {
      if ((name === 'deposit' || name === 'withdraw') && t.length === 3 && Array.isArray(d) && d.length >= 2) {
        const pool = str(t[1]);
        if (!pool || t[2] !== acct) {
          unmatched.add(name);
          continue;
        }
        const first = big(d[0]);
        const second = big(d[1]);
        if (first === null || second === null) continue;
        if (name === 'deposit') {
          const f = claimFlow(ctx, (x) => x.kind === 'transfer' && x.from === acct && x.amount === first);
          if (!f) { out.push(behalf(id, 'backstop deposit')); continue; }
          out.push(baseEvent(ctx, {
            kind: 'lend_supply', protocol: 'blend', confidence: 'exact', counterparty: id,
            legs: [{ direction: 'out', asset: f.asset, amount: first, decimals: ctx.reg.decimalsOf(f.asset) }],
            position: pos('blend-backstop', pool, f.asset, second, 'in', first),
            note: `Blend backstop deposit to pool ${pool.slice(0, 6)}, ${second} shares`,
          }));
        } else {
          // withdraw data is [shares_burnt, tokens_out]
          const f = claimFlow(ctx, (x) => (x.kind === 'transfer' || x.kind === 'mint') && x.to === acct && x.amount === second);
          if (!f) { out.push(behalf(id, 'backstop withdrawal')); continue; }
          out.push(baseEvent(ctx, {
            kind: 'lend_withdraw', protocol: 'blend', confidence: 'exact', counterparty: id,
            legs: [{ direction: 'in', asset: f.asset, amount: second, decimals: ctx.reg.decimalsOf(f.asset) }],
            position: pos('blend-backstop', pool, f.asset, first, 'out', second),
            note: `Blend backstop withdrawal from pool ${pool.slice(0, 6)}, ${first} shares burnt`,
          }));
        }
      } else if ((name === 'queue_withdrawal' || name === 'dequeue_withdrawal') && t.length === 3 && t[2] === acct) {
        const amount = Array.isArray(d) ? big(d[0]) : big(d);
        const exp = Array.isArray(d) ? big(d[1]) : null;
        out.push(baseEvent(ctx, {
          kind: 'no_op', protocol: 'blend', confidence: 'exact', counterparty: id, legs: [],
          note: name === 'queue_withdrawal'
            ? `Blend backstop withdrawal queued: ${amount ?? '?'} shares${exp !== null ? `, claimable after ${new Date(Number(exp) * 1000).toISOString().slice(0, 10)}` : ''}`
            : `Blend backstop withdrawal cancelled: ${amount ?? '?'} shares`,
        }));
      } else if (name === 'claim' && t.length === 2 && t[1] === acct) {
        const amount = big(d);
        if (amount === null) continue;
        const f = claimFlow(ctx, (x) => (x.kind === 'transfer' || x.kind === 'mint') && x.to === acct && x.amount === amount);
        if (!f) continue;
        out.push(baseEvent(ctx, {
          kind: 'reward_claim', protocol: 'blend', confidence: 'exact', counterparty: id,
          legs: [{ direction: 'in', asset: f.asset, amount, decimals: ctx.reg.decimalsOf(f.asset) }],
          note: 'Blend backstop emissions claim (LP tokens)',
        }));
      } else {
        unmatched.add(name);
      }
      continue;
    }

    // ---------------------------------------------------------------------- POOL
    if ((SUPPLY.has(name) || WITHDRAW.has(name) || name === 'borrow' || name === 'repay') && t.length === 3) {
      if (t[2] !== acct) { unmatched.add(name); continue; }
      const assetId = str(t[1]);
      if (!assetId || !Array.isArray(d) || d.length < 2) continue;
      const tokens = big(d[0]);
      const shares = big(d[1]);
      if (tokens === null || shares === null) continue;
      const asset = ctx.reg.canonical(assetId);
      const dec = ctx.reg.decimalsOf(asset);
      const inbound = WITHDRAW.has(name) || name === 'borrow';
      const flow = claimFlow(ctx, (f) =>
        f.kind === 'transfer' && f.asset === asset && f.amount === tokens && (inbound ? f.to === acct : f.from === acct));
      if (!flow) { out.push(behalf(id, name.replace('_', ' '))); continue; }
      const leg = { direction: inbound ? 'in' as const : 'out' as const, asset, amount: tokens, decimals: dec };
      if (SUPPLY.has(name)) {
        out.push(baseEvent(ctx, { kind: 'lend_supply', protocol: 'blend', confidence: 'exact', counterparty: id, legs: [leg],
          position: pos('blend', id, asset, shares, 'in', tokens), note: `Blend ${name}, ${shares} b-tokens minted` }));
      } else if (WITHDRAW.has(name)) {
        out.push(baseEvent(ctx, { kind: 'lend_withdraw', protocol: 'blend', confidence: 'exact', counterparty: id, legs: [leg],
          position: pos('blend', id, asset, shares, 'out', tokens), note: `Blend ${name}, ${shares} b-tokens burnt` }));
      } else if (name === 'borrow') {
        out.push(baseEvent(ctx, { kind: 'borrow', protocol: 'blend', confidence: 'exact', counterparty: id, legs: [leg],
          position: pos('blend-debt', id, asset, shares, 'in', tokens), note: `Blend borrow, ${shares} d-tokens minted` }));
      } else {
        out.push(baseEvent(ctx, { kind: 'repay', protocol: 'blend', confidence: 'exact', counterparty: id, legs: [leg],
          position: pos('blend-debt', id, asset, shares, 'out', tokens), note: `Blend repay, ${shares} d-tokens burnt` }));
      }
    } else if (name === 'flash_loan' && t.length === 4) {
      if (t[2] !== acct) { unmatched.add(name); continue; }
      const assetId = str(t[1]);
      if (!assetId || !Array.isArray(d) || d.length < 2) continue;
      const tokens = big(d[0]);
      const shares = big(d[1]);
      if (tokens === null || shares === null) continue;
      const asset = ctx.reg.canonical(assetId);
      // The loan is paid to the receiver contract (topic 3), not to this wallet: debt without cash.
      out.push(baseEvent(ctx, { kind: 'borrow', protocol: 'blend', confidence: 'exact', counterparty: id, legs: [],
        position: pos('blend-debt', id, asset, shares, 'in', tokens),
        note: `Blend flash loan of ${tokens} paid to ${String(t[3]).slice(0, 6)}, ${shares} d-tokens minted` }));
    } else if (name === 'claim' && t.length === 2) {
      if (t[1] !== acct) { unmatched.add(name); continue; }
      const amount = Array.isArray(d) ? big(d[1]) : null;
      if (amount === null) continue;
      // The event does not name the emission asset; it is the matching inbound transfer.
      const f = claimFlow(ctx, (x) => x.kind === 'transfer' && x.to === acct && x.amount === amount);
      if (!f) continue;
      out.push(baseEvent(ctx, { kind: 'reward_claim', protocol: 'blend', confidence: 'exact', counterparty: id,
        legs: [{ direction: 'in', asset: f.asset, amount, decimals: ctx.reg.decimalsOf(f.asset) }], note: 'Blend emissions claim' }));
    } else if (name === 'bad_debt' && t.length === 3) {
      if (t[1] !== acct) { unmatched.add(name); continue; }
      const assetId = str(t[2]);
      const dTokens = big(d);
      if (!assetId || dTokens === null) continue;
      out.push(baseEvent(ctx, { kind: 'liquidation', protocol: 'blend', confidence: 'exact', counterparty: id, legs: [],
        positions: [pos('blend-debt', id, ctx.reg.canonical(assetId), dTokens, 'out')],
        note: `Blend bad debt: ${dTokens} d-tokens of debt moved to the backstop` }));
    } else if ((name === 'new_auction' || name === 'delete_auction' || name === 'fill_auction') && t.length === 3) {
      const type = typeof t[1] === 'number' ? t[1] : Number(t[1]);
      const user = str(t[2]);
      const label = AUCTION_TYPES[type] ?? `type ${type}`;
      if (name === 'new_auction') {
        if (user !== acct) { unmatched.add(name); continue; }
        const pct = Array.isArray(d) ? d[0] : '?';
        out.push(baseEvent(ctx, { kind: 'no_op', protocol: 'blend', confidence: 'exact', counterparty: id, legs: [],
          note: `Blend ${label} started against this account (${pct}% of the position)` }));
      } else if (name === 'delete_auction') {
        if (user !== acct) { unmatched.add(name); continue; }
        out.push(baseEvent(ctx, { kind: 'no_op', protocol: 'blend', confidence: 'exact', counterparty: id, legs: [], note: `Blend ${label} cancelled` }));
      } else {
        if (!Array.isArray(d) || d.length < 3) continue;
        const filler = str(d[0]);
        const pct = big(d[1]);
        const ad = d[2] as { bid?: unknown; lot?: unknown } | null;
        const bid = amountMap(ad?.bid);
        const lot = amountMap(ad?.lot);
        if (!bid || !lot) continue;
        const involved = user === acct ? 'liquidated' : filler === acct ? 'filler' : null;
        if (!involved) { unmatched.add(name); continue; }
        if (type !== 0) {
          // Bad-debt and interest auctions move real tokens between filler and pool; the generic
          // flow classifier books those, this only records what the event was.
          out.push(baseEvent(ctx, { kind: 'no_op', protocol: 'blend', confidence: 'exact', counterparty: id, legs: [],
            note: `Blend ${label} filled ${pct ?? '?'}%; token movements are classified from transfers` }));
          continue;
        }
        // User liquidation: lot = b-tokens (collateral) to the filler, bid = d-tokens (debt) the filler assumes.
        const dir: 'in' | 'out' = involved === 'liquidated' ? 'out' : 'in';
        const positions: PositionChange[] = [
          ...lot.map(([a, n]) => pos('blend', id, ctx.reg.canonical(a), n, dir)),
          ...bid.map(([a, n]) => pos('blend-debt', id, ctx.reg.canonical(a), n, dir)),
        ];
        out.push(baseEvent(ctx, { kind: 'liquidation', protocol: 'blend', confidence: 'exact', counterparty: id, legs: [], positions,
          note: involved === 'liquidated'
            ? `Blend liquidation: ${pct}% filled by ${filler?.slice(0, 6)}, collateral seized and debt cleared`
            : `Blend liquidation filled ${pct}% for ${user?.slice(0, 6)}: collateral received and debt assumed` }));
      }
    } else {
      unmatched.add(name);
    }
  }

  // The account called Blend (e.g. gulp, set_status) but nothing in it concerns this account's value.
  const participant = ctx.tx.sourceAccount === acct || ctx.tx.feeAccount === acct;
  if (out.length === 0 && unmatched.size > 0 && participant) {
    out.push(baseEvent(ctx, { kind: 'no_op', protocol: 'blend', confidence: 'exact', legs: [],
      note: `Blend ${[...unmatched].join(', ')}: no value moved for this account` }));
  }
  return out;
}
