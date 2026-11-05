/**
 * Accounting engine: replays LedgerEvents in chronological order, prices each leg, maintains tax
 * lots and lending positions, and emits disposals, income, expenses and warnings.
 * Treatment rules are explicit in `Policy` (see docs/ACCOUNTING-POLICY.md) and never implicit.
 */
import type { LedgerEvent, Leg, PositionChange } from '../types.ts';
import { RATE_SCALE, type RateBook } from '../blend/rates.ts';
import type { PriceProvider } from '../pricing/types.ts';
import { LotBook, type Disposal, type LotMethod } from './lots.ts';
import { Positions } from './positions.ts';
import { Debts, type Debt } from './debt.ts';
import { fmtUsd, valueMicro, type Micro } from './money.ts';

export interface Policy {
  lotMethod: LotMethod;
  /** 'disposal': adding/removing liquidity is a taxable swap; 'carryover': basis moves into the share token. */
  lp: 'disposal' | 'carryover';
  /** Lending supply/withdraw: 'carryover' (non-taxable, default) or 'disposal'. */
  lending: 'carryover' | 'disposal';
  /** Addresses that belong to the same owner: transfers between them are not taxable. */
  ownAddresses: Set<string>;
}

export const DEFAULT_POLICY: Policy = {
  lotMethod: 'FIFO',
  lp: 'disposal',
  lending: 'carryover',
  ownAddresses: new Set(),
};

export interface IncomeItem {
  eventId: string;
  at: string;
  kind: 'interest' | 'reward';
  asset: string;
  units: bigint;
  decimals: number;
  valueMicro: Micro;
  priceSource: string;
}

export interface ExpenseItem {
  eventId: string;
  at: string;
  kind: 'network_fee' | 'borrow_interest';
  asset: string;
  units: bigint;
  decimals: number;
  valueMicro: Micro;
}

export interface Warning {
  eventId: string;
  code:
    | 'unpriced' | 'no_lots' | 'unknown_basis' | 'unclassified' | 'negative_interest' | 'lp_value_unpriced'
    | 'unknown_debt' | 'liquidation_unvalued' | 'liquidation_estimated';
  message: string;
}

export interface PricedLeg extends Leg {
  priceMicro: Micro | null;
  valueMicro: Micro | null;
  priceSource: string | null;
}

export interface EngineResult {
  disposals: Disposal[];
  income: IncomeItem[];
  expenses: ExpenseItem[];
  warnings: Warning[];
  pricedLegs: Map<string, PricedLeg[]>; // event id -> legs with USD values (for export)
  openBalances: { asset: string; units: bigint }[];
  positions: ReturnType<Positions['snapshot']>;
  debts: Debt[];
}

export class Engine {
  readonly book: LotBook;
  readonly positions = new Positions();
  readonly debts = new Debts();
  /** Legacy per-asset debt, only for events without a share position (non-Blend decoders). */
  private debt = new Map<string, bigint>();
  readonly disposals: Disposal[] = [];
  readonly income: IncomeItem[] = [];
  readonly expenses: ExpenseItem[] = [];
  readonly warnings: Warning[] = [];
  readonly pricedLegs = new Map<string, PricedLeg[]>();
  private policy: Policy;
  private prices: PriceProvider;

  private rates: RateBook | null;

  constructor(prices: PriceProvider, policy: Policy = DEFAULT_POLICY, rates: RateBook | null = null) {
    this.rates = rates;
    this.prices = prices;
    this.policy = policy;
    this.book = new LotBook(policy.lotMethod);
  }

  private warn(eventId: string, code: Warning['code'], message: string): void {
    this.warnings.push({ eventId, code, message });
  }

  private async priceLegs(ev: LedgerEvent): Promise<PricedLeg[]> {
    const out: PricedLeg[] = [];
    for (const l of ev.legs) {
      const p = await this.prices.price(l.asset, ev.closedAt);
      out.push({
        ...l,
        priceMicro: p?.micro ?? null,
        valueMicro: p ? valueMicro(l.amount, l.decimals, p.micro) : null,
        priceSource: p?.source ?? null,
      });
      if (!p) this.warn(ev.id, 'unpriced', `no USD price for ${l.asset} at ${ev.closedAt}`);
    }
    this.pricedLegs.set(ev.id, out);
    return out;
  }

  private sum(legs: PricedLeg[]): Micro | null {
    let t = 0n;
    for (const l of legs) {
      if (l.valueMicro === null) return null;
      t += l.valueMicro;
    }
    return t;
  }

  /** Dispose units of an out-leg; any untracked shortfall is acquired-at-zero-basis-flagged, not hidden. */
  private disposeLeg(ev: LedgerEvent, l: PricedLeg, proceeds: Micro): void {
    const { disposals, shortfall } = this.book.dispose(l.asset, l.amount, proceeds, ev.closedAt);
    this.disposals.push(...disposals);
    if (shortfall > 0n) {
      this.warn(ev.id, 'no_lots', `${shortfall} base units of ${l.asset} disposed with no tracked lots (history before sync start?)`);
      const share = l.amount === 0n ? 0n : (proceeds * shortfall) / l.amount;
      this.disposals.push({
        asset: l.asset, units: shortfall, basisMicro: 0n, proceedsMicro: share, gainMicro: share,
        acquiredAt: ev.closedAt, disposedAt: ev.closedAt, longTerm: false, lotId: 0,
      });
    }
  }

  /** Allocate `total` over legs proportionally to their own values (equal split if none priced). */
  private allocate(legs: PricedLeg[], total: Micro): Micro[] {
    const weights = legs.map((l) => l.valueMicro ?? 0n);
    const w = weights.reduce((a, b) => a + b, 0n);
    if (w === 0n) return legs.map((_, i) => (i === 0 ? total : 0n));
    let used = 0n;
    return weights.map((x, i) => {
      if (i === legs.length - 1) return total - used;
      const part = (total * x) / w;
      used += part;
      return part;
    });
  }

  /**
   * Value a Blend user liquidation from rates implied by pool events (blend/rates.ts).
   * Returns false, touching nothing, if any rate, price or position needed is missing.
   *
   * Policy 'debt relief' (conventional, not tax advice): the liquidated user disposes of the seized
   * collateral for the value of the debt it relieves; the tokens of cleared debt beyond tracked
   * principal are borrow interest. The liquidator acquires the collateral at the value of the debt
   * it assumes, so its bonus is realised when it later sells.
   */
  private async valueLiquidation(ev: LedgerEvent): Promise<boolean> {
    const ps = ev.positions ?? [];
    const collat = ps.filter((p) => p.protocol === 'blend');
    const debts = ps.filter((p) => p.protocol === 'blend-debt');
    if (!this.rates || collat.length === 0 || debts.length === 0) return false;
    const inbound = ps.every((p) => p.direction === 'in');
    const outbound = ps.every((p) => p.direction === 'out');
    if (!inbound && !outbound) return false;

    type Valued = { p: PositionChange; tokens: bigint; usd: Micro; priceMicro: bigint; dist: number };
    const value = async (p: PositionChange, side: 'b' | 'd'): Promise<Valued | null> => {
      const hit = this.rates!.lookup(p.pool, p.asset, side, ev.ledger);
      const price = await this.prices.price(p.asset, ev.closedAt);
      if (!hit || !price) return null;
      const tokens = (p.shares * hit.rate12 + RATE_SCALE / 2n) / RATE_SCALE;
      return { p, tokens, usd: valueMicro(tokens, p.decimals ?? 7, price.micro), priceMicro: price.micro, dist: hit.distance };
    };
    const cv: Valued[] = [];
    const dv: Valued[] = [];
    for (const p of collat) { const v = await value(p, 'b'); if (!v) return false; cv.push(v); }
    for (const p of debts) { const v = await value(p, 'd'); if (!v) return false; dv.push(v); }
    const C = cv.reduce((s, v) => s + v.usd, 0n);
    const D = dv.reduce((s, v) => s + v.usd, 0n);
    if (C <= 0n || D <= 0n) return false;
    const maxDist = Math.max(...cv.map((v) => v.dist), ...dv.map((v) => v.dist));
    const parts: string[] = [];

    if (inbound) {
      // Liquidator: collateral is bought for the debt assumed (basis = D split by collateral value).
      for (const v of cv) {
        const basis = (D * v.usd) / C;
        this.positions.deposit(Positions.key(v.p.protocol, v.p.pool, v.p.asset), v.p.shares, v.tokens, [
          { asset: v.p.asset, units: v.tokens, basisMicro: basis, acquiredAt: ev.closedAt },
        ]);
        parts.push(`${v.tokens} ${v.p.asset.split(':')[0]} of collateral acquired for a basis of $${fmtUsd(basis)}`);
      }
      for (const v of dv) {
        this.debts.borrow(Positions.key(v.p.protocol, v.p.pool, v.p.asset), v.p.shares, v.tokens);
        parts.push(`${v.tokens} ${v.p.asset.split(':')[0]} of debt assumed`);
      }
    } else {
      // Liquidated user: disposal of the seized collateral for the debt relieved.
      for (const v of cv) {
        const proceedsAll = (D * v.usd) / C;
        const r = this.positions.seize(Positions.key(v.p.protocol, v.p.pool, v.p.asset), v.p.shares);
        const used = v.p.shares - r.shareShortfall;
        if (r.shareShortfall > 0n) {
          this.warn(ev.id, 'no_lots', `${r.shareShortfall} b-tokens of ${v.p.asset.split(':')[0]} collateral seized had no tracked deposit (history before the sync window); no gain is booked for that part`);
        }
        if (used > 0n && r.principalUnits > 0n) {
          const proceeds = v.p.shares === 0n ? 0n : (proceedsAll * used) / v.p.shares;
          const at = r.earliestAt ?? ev.closedAt;
          this.disposals.push({
            asset: v.p.asset, units: r.principalUnits, basisMicro: r.basisMicro, proceedsMicro: proceeds, gainMicro: proceeds - r.basisMicro,
            acquiredAt: at, disposedAt: ev.closedAt, longTerm: Date.parse(ev.closedAt) - Date.parse(at) > 365 * 86_400_000, lotId: 0,
          });
          parts.push(`${r.principalUnits} ${v.p.asset.split(':')[0]} disposed for $${fmtUsd(proceeds)} against a basis of $${fmtUsd(r.basisMicro)}`);
        }
      }
      for (const v of dv) {
        const r = this.debts.clear(Positions.key(v.p.protocol, v.p.pool, v.p.asset), v.p.shares);
        if (r.shareShortfall > 0n) {
          this.warn(ev.id, 'unknown_debt', `${r.shareShortfall} d-tokens of ${v.p.asset.split(':')[0]} debt cleared were borrowed before the sync window; their interest cannot be split out`);
        }
        const used = v.p.shares - r.shareShortfall;
        if (used > 0n) {
          const tracked = (v.tokens * used) / v.p.shares;
          const interest = tracked - r.principalUnits;
          if (interest > 0n) {
            this.expenses.push({ eventId: ev.id, at: ev.closedAt, kind: 'borrow_interest', asset: v.p.asset, units: interest, decimals: v.p.decimals ?? 7, valueMicro: valueMicro(interest, v.p.decimals ?? 7, v.priceMicro) });
          }
        }
        parts.push(`${v.tokens} ${v.p.asset.split(':')[0]} of debt relieved`);
      }
    }
    this.warn(ev.id, 'liquidation_estimated', `${ev.note}. Valued with pool rates implied by events up to ${maxDist} ledgers away: ${parts.join('; ')}.`);
    return true;
  }

  async apply(ev: LedgerEvent): Promise<void> {
    const legs = await this.priceLegs(ev);
    const ins = legs.filter((l) => l.direction === 'in');
    const outs = legs.filter((l) => l.direction === 'out');

    switch (ev.kind) {
      case 'transfer_in':
      case 'mint': {
        if (ev.counterparty && this.policy.ownAddresses.has(ev.counterparty)) return; // internal
        for (const l of ins) this.book.acquire(l.asset, l.amount, l.valueMicro ?? 0n, ev.closedAt, ev.kind);
        return;
      }
      case 'transfer_out':
      case 'burn': {
        if (ev.counterparty && this.policy.ownAddresses.has(ev.counterparty)) return; // internal
        for (const l of outs) this.disposeLeg(ev, l, l.valueMicro ?? 0n);
        return;
      }
      case 'fee': {
        for (const l of outs) {
          this.disposeLeg(ev, l, l.valueMicro ?? 0n);
          this.expenses.push({ eventId: ev.id, at: ev.closedAt, kind: 'network_fee', asset: l.asset, units: l.amount, decimals: l.decimals, valueMicro: l.valueMicro ?? 0n });
        }
        return;
      }
      case 'trade': {
        const total = this.sum(ins) ?? this.sum(outs);
        if (total === null) this.warn(ev.id, 'unpriced', 'trade value unknown; basis set to zero');
        const proceeds = total ?? 0n;
        const outAlloc = this.allocate(outs, proceeds);
        outs.forEach((l, i) => this.disposeLeg(ev, l, outAlloc[i]!));
        const inAlloc = this.allocate(ins, proceeds);
        ins.forEach((l, i) => this.book.acquire(l.asset, l.amount, inAlloc[i]!, ev.closedAt, 'trade'));
        return;
      }
      case 'lp_add':
      case 'vault_deposit': {
        const shares = ins; // minted share token
        if (this.policy.lp === 'disposal') {
          const total = this.sum(outs) ?? this.sum(shares);
          if (total === null) this.warn(ev.id, 'lp_value_unpriced', 'liquidity add value unknown; basis set to zero');
          const proceeds = total ?? 0n;
          const alloc = this.allocate(outs, proceeds);
          outs.forEach((l, i) => this.disposeLeg(ev, l, alloc[i]!));
          const sAlloc = this.allocate(shares, proceeds);
          shares.forEach((l, i) => this.book.acquire(l.asset, l.amount, sAlloc[i]!, ev.closedAt, ev.kind));
        } else {
          let basis = 0n;
          let earliest = ev.closedAt;
          for (const l of outs) {
            const { carries, shortfall } = this.book.carryOut(l.asset, l.amount);
            for (const c of carries) {
              basis += c.basisMicro;
              if (c.acquiredAt < earliest) earliest = c.acquiredAt;
            }
            if (shortfall > 0n) {
              this.warn(ev.id, 'no_lots', `${shortfall} units of ${l.asset} moved into liquidity with no tracked lots`);
              basis += l.valueMicro !== null && l.amount > 0n ? (l.valueMicro * shortfall) / l.amount : 0n;
            }
          }
          const sAlloc = this.allocate(shares, basis);
          shares.forEach((l, i) => this.book.acquire(l.asset, l.amount, sAlloc[i]!, earliest, ev.kind));
        }
        return;
      }
      case 'lp_remove':
      case 'vault_withdraw': {
        const shares = outs; // burnt share token
        if (this.policy.lp === 'disposal') {
          const total = this.sum(ins) ?? this.sum(shares);
          if (total === null) this.warn(ev.id, 'lp_value_unpriced', 'liquidity removal value unknown; basis set to zero');
          const proceeds = total ?? 0n;
          const alloc = this.allocate(shares, proceeds);
          shares.forEach((l, i) => this.disposeLeg(ev, l, alloc[i]!));
          const iAlloc = this.allocate(ins, proceeds);
          ins.forEach((l, i) => this.book.acquire(l.asset, l.amount, iAlloc[i]!, ev.closedAt, ev.kind));
        } else {
          let basis = 0n;
          let earliest = ev.closedAt;
          for (const l of shares) {
            const { carries } = this.book.carryOut(l.asset, l.amount);
            for (const c of carries) {
              basis += c.basisMicro;
              if (c.acquiredAt < earliest) earliest = c.acquiredAt;
            }
          }
          const iAlloc = this.allocate(ins, basis);
          ins.forEach((l, i) => this.book.acquire(l.asset, l.amount, iAlloc[i]!, earliest, ev.kind));
        }
        return;
      }
      case 'lend_supply': {
        const l = outs[0];
        if (!l || !ev.position) return;
        const key = Positions.key(ev.position.protocol, ev.position.pool, ev.position.asset);
        if (this.policy.lending === 'disposal') {
          this.disposeLeg(ev, l, l.valueMicro ?? 0n);
          this.positions.deposit(key, ev.position.shares, l.amount, [{ asset: l.asset, units: l.amount, basisMicro: l.valueMicro ?? 0n, acquiredAt: ev.closedAt }]);
          return;
        }
        const { carries, shortfall } = this.book.carryOut(l.asset, l.amount);
        if (shortfall > 0n) {
          this.warn(ev.id, 'no_lots', `${shortfall} units of ${l.asset} supplied with no tracked lots; basis estimated at FMV`);
          const est = l.valueMicro !== null && l.amount > 0n ? (l.valueMicro * shortfall) / l.amount : 0n;
          carries.push({ asset: l.asset, units: shortfall, basisMicro: est, acquiredAt: ev.closedAt });
        }
        this.positions.deposit(key, ev.position.shares, l.amount, carries);
        return;
      }
      case 'lend_withdraw': {
        const l = ins[0];
        if (!l || !ev.position) return;
        const key = Positions.key(ev.position.protocol, ev.position.pool, ev.position.asset);
        const r = this.positions.withdraw(key, ev.position.shares, l.amount);
        // principal returns to the wallet with its original basis and dates
        for (const c of r.carries) this.book.acquire(l.asset, c.units, c.basisMicro, c.acquiredAt, 'lend_withdraw');
        const price = l.priceMicro;
        if (r.interestUnits > 0n) {
          const v = price === null ? 0n : valueMicro(r.interestUnits, l.decimals, price);
          this.book.acquire(l.asset, r.interestUnits, v, ev.closedAt, 'interest_income');
          this.income.push({ eventId: ev.id, at: ev.closedAt, kind: 'interest', asset: l.asset, units: r.interestUnits, decimals: l.decimals, valueMicro: v, priceSource: l.priceSource ?? 'none' });
        } else if (r.interestUnits < 0n) {
          this.warn(ev.id, 'negative_interest', `withdrew ${-r.interestUnits} base units less than principal (pool loss)`);
        }
        if (r.unknownUnits > 0n) {
          const v = price === null ? 0n : valueMicro(r.unknownUnits, l.decimals, price);
          this.book.acquire(l.asset, r.unknownUnits, v, ev.closedAt, 'unknown_basis');
          this.warn(ev.id, 'unknown_basis', `${r.unknownUnits} base units of ${l.asset} withdrawn for shares deposited before the sync window; basis set to FMV`);
        }
        return;
      }
      case 'borrow': {
        const l = ins[0];
        const p = ev.position;
        if (p?.protocol === 'blend-debt') this.debts.borrow(Positions.key(p.protocol, p.pool, p.asset), p.shares, p.tokens ?? l?.amount ?? 0n);
        if (!l) return; // flash loan: the cash went to a receiver contract, not this wallet
        if (!p) this.debt.set(l.asset, (this.debt.get(l.asset) ?? 0n) + l.amount);
        this.book.acquire(l.asset, l.amount, l.valueMicro ?? 0n, ev.closedAt, 'borrow');
        return;
      }
      case 'liquidation': {
        if (await this.valueLiquidation(ev)) return;
        // No usable rate or price: collateral seized and debt cleared are moves of shares, not cash.
        // Keep the share ledgers consistent, book no gain or loss, and say so. Never guess.
        const notes: string[] = [];
        for (const p of ev.positions ?? []) {
          const key = Positions.key(p.protocol, p.pool, p.asset);
          const sym = p.asset.split(':')[0]!;
          if (p.protocol === 'blend-debt') {
            if (p.direction === 'out') {
              const r = this.debts.clear(key, p.shares);
              notes.push(`${p.shares} d-tokens of ${sym} debt cleared (${r.principalUnits} units of tracked principal)`);
            } else notes.push(`${p.shares} d-tokens of ${sym} debt assumed`);
          } else if (p.direction === 'out') {
            const r = this.positions.seize(key, p.shares);
            notes.push(`${p.shares} b-tokens of ${sym} collateral seized (tracked principal ${r.principalUnits} units, cost basis $${fmtUsd(r.basisMicro)})`);
          } else notes.push(`${p.shares} b-tokens of ${sym} collateral received`);
        }
        this.warn(ev.id, 'liquidation_unvalued', `${ev.note}. ${notes.join('; ')}. Value needs pool rates; no gain or loss is booked.`);
        return;
      }
      case 'repay': {
        const l = outs[0];
        if (!l) return;
        const p = ev.position;
        if (p?.protocol === 'blend-debt') {
          const r = this.debts.repay(Positions.key(p.protocol, p.pool, p.asset), p.shares, l.amount);
          this.disposeLeg(ev, l, l.valueMicro ?? 0n);
          if (r.interestUnits > 0n) {
            const v = l.priceMicro === null ? 0n : valueMicro(r.interestUnits, l.decimals, l.priceMicro);
            this.expenses.push({ eventId: ev.id, at: ev.closedAt, kind: 'borrow_interest', asset: l.asset, units: r.interestUnits, decimals: l.decimals, valueMicro: v });
          }
          if (r.unknownUnits > 0n) {
            this.warn(ev.id, 'unknown_debt', `${r.unknownUnits} base units of ${l.asset} repaid for debt borrowed before the sync window or taken over in a liquidation; the interest part cannot be split out`);
          }
          return;
        }
        const owed = this.debt.get(l.asset) ?? 0n;
        const principal = l.amount < owed ? l.amount : owed;
        const interest = l.amount - principal;
        this.debt.set(l.asset, owed - principal);
        this.disposeLeg(ev, l, l.valueMicro ?? 0n);
        if (interest > 0n) {
          const v = l.priceMicro === null ? 0n : valueMicro(interest, l.decimals, l.priceMicro);
          this.expenses.push({ eventId: ev.id, at: ev.closedAt, kind: 'borrow_interest', asset: l.asset, units: interest, decimals: l.decimals, valueMicro: v });
        }
        return;
      }
      case 'reward_claim': {
        for (const l of ins) {
          this.book.acquire(l.asset, l.amount, l.valueMicro ?? 0n, ev.closedAt, 'reward');
          this.income.push({ eventId: ev.id, at: ev.closedAt, kind: 'reward', asset: l.asset, units: l.amount, decimals: l.decimals, valueMicro: l.valueMicro ?? 0n, priceSource: l.priceSource ?? 'none' });
        }
        return;
      }
      case 'unclassified':
        this.warn(ev.id, 'unclassified', ev.note);
        return;
      default:
        return;
    }
  }

  result(): EngineResult {
    return {
      disposals: this.disposals,
      income: this.income,
      expenses: this.expenses,
      warnings: this.warnings,
      pricedLegs: this.pricedLegs,
      openBalances: this.book.assets().map((asset) => ({ asset, units: this.book.balance(asset) })),
      positions: this.positions.snapshot(),
      debts: this.debts.snapshot(),
    };
  }
}

/** Chronological replay order: ledger, then application order within the ledger (tx hash tiebreak). */
export const byChronology = (a: LedgerEvent, b: LedgerEvent): number =>
  a.ledger - b.ledger ||
  a.txOrder - b.txOrder ||
  Number(a.id.split(':')[1]) - Number(b.id.split(':')[1]);
