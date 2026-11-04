/** JSON-safe view of an engine result for the web UI. USD values are decimal strings (no floats). */
import type { LedgerEvent } from './types.ts';
import type { EngineResult } from './ledger/engine.ts';
import { fmtUnits, fmtUsd } from './ledger/money.ts';
import { symbolOf } from './assets.ts';

const usdOfLegs = (res: EngineResult, e: LedgerEvent): string | null => {
  const legs = res.pricedLegs.get(e.id) ?? [];
  if (legs.length === 0 || legs.some((l) => l.valueMicro === null)) return null;
  const incoming = legs.filter((l) => l.direction === 'in').reduce((s, l) => s + (l.valueMicro ?? 0n), 0n);
  return fmtUsd(incoming || legs.reduce((s, l) => s + (l.valueMicro ?? 0n), 0n));
};

export function reportDto(accounts: string[], events: LedgerEvent[], res: EngineResult, year?: number) {
  const inYear = (iso: string): boolean => (year ? iso.startsWith(String(year)) : true);
  const evs = events.filter((e) => inYear(e.closedAt));
  const disposals = res.disposals.filter((d) => inYear(d.disposedAt));
  const income = res.income.filter((i) => inYear(i.at));
  const expenses = res.expenses.filter((x) => inYear(x.at));
  const sum = (xs: bigint[]): bigint => xs.reduce((s, x) => s + x, 0n);

  const byKind: Record<string, number> = {};
  for (const e of evs) byKind[e.kind] = (byKind[e.kind] ?? 0) + 1;

  const warningCounts: Record<string, number> = {};
  for (const w of res.warnings) warningCounts[w.code] = (warningCounts[w.code] ?? 0) + 1;

  return {
    accounts,
    year: year ?? null,
    years: [...new Set(events.map((e) => e.closedAt.slice(0, 4)))].sort(),
    totals: {
      events: evs.length,
      byKind,
      confidence: {
        exact: evs.filter((e) => e.confidence === 'exact').length,
        heuristic: evs.filter((e) => e.confidence === 'heuristic').length,
        unknown: evs.filter((e) => e.confidence === 'unknown').length,
      },
      gains: {
        shortTerm: fmtUsd(sum(disposals.filter((d) => !d.longTerm).map((d) => d.gainMicro))),
        longTerm: fmtUsd(sum(disposals.filter((d) => d.longTerm).map((d) => d.gainMicro))),
        disposals: disposals.length,
      },
      income: {
        interest: fmtUsd(sum(income.filter((i) => i.kind === 'interest').map((i) => i.valueMicro))),
        reward: fmtUsd(sum(income.filter((i) => i.kind === 'reward').map((i) => i.valueMicro))),
      },
      expenses: {
        networkFees: fmtUsd(sum(expenses.filter((x) => x.kind === 'network_fee').map((x) => x.valueMicro))),
        borrowInterest: fmtUsd(sum(expenses.filter((x) => x.kind === 'borrow_interest').map((x) => x.valueMicro))),
      },
    },
    balances: res.openBalances.map((b) => ({ asset: b.asset, symbol: symbolOf(b.asset), units: fmtUnits(b.units, 7) })),
    positions: res.positions.map((p) => ({
      key: p.key,
      asset: symbolOf(p.key.split(':').slice(2).join(':')),
      principal: fmtUnits(p.principalUnits, 7),
      shares: String(p.shares),
    })),
    warnings: { counts: warningCounts, items: res.warnings.slice(0, 500) },
    events: evs.map((e) => ({
      id: e.id,
      time: e.closedAt,
      ledger: e.ledger,
      tx: e.txHash,
      kind: e.kind,
      protocol: e.protocol,
      confidence: e.confidence,
      counterparty: e.counterparty,
      note: e.note,
      usd: usdOfLegs(res, e),
      legs: e.legs.map((l) => ({ dir: l.direction, amount: fmtUnits(l.amount, l.decimals), symbol: symbolOf(l.asset) })),
    })),
    gains: disposals.map((d) => ({
      asset: symbolOf(d.asset),
      units: fmtUnits(d.units, 7),
      acquired: d.acquiredAt,
      disposed: d.disposedAt,
      proceeds: fmtUsd(d.proceedsMicro),
      basis: fmtUsd(d.basisMicro),
      gain: fmtUsd(d.gainMicro),
      term: d.longTerm ? 'long' : 'short',
    })),
    income: income.map((i) => ({
      time: i.at,
      kind: i.kind,
      asset: symbolOf(i.asset),
      units: fmtUnits(i.units, i.decimals),
      usd: fmtUsd(i.valueMicro),
      source: i.priceSource,
    })),
  };
}
