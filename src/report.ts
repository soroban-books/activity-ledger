import type { LedgerEvent } from './types.ts';
import type { EngineResult } from './ledger/engine.ts';
import { fmtUnits, fmtUsd } from './ledger/money.ts';
import { symbolOf } from './assets.ts';

export function summary(events: LedgerEvent[], res: EngineResult, year?: number): string {
  const inYear = (iso: string): boolean => (year ? iso.startsWith(String(year)) : true);
  const out: string[] = [];
  const byKind = new Map<string, number>();
  for (const e of events) if (inYear(e.closedAt)) byKind.set(e.kind, (byKind.get(e.kind) ?? 0) + 1);
  out.push(`Events${year ? ` in ${year}` : ''}: ${[...byKind].map(([k, v]) => `${k}=${v}`).join('  ') || 'none'}`);

  const exact = events.filter((e) => e.confidence === 'exact').length;
  const heur = events.filter((e) => e.confidence === 'heuristic').length;
  const unk = events.filter((e) => e.confidence === 'unknown').length;
  out.push(`Classification confidence: exact=${exact} heuristic=${heur} unknown=${unk}`);

  const d = res.disposals.filter((x) => inYear(x.disposedAt));
  const short = d.filter((x) => !x.longTerm).reduce((s, x) => s + x.gainMicro, 0n);
  const long = d.filter((x) => x.longTerm).reduce((s, x) => s + x.gainMicro, 0n);
  out.push(`Realized gains: short-term $${fmtUsd(short)}  long-term $${fmtUsd(long)}  (${d.length} disposals)`);

  const inc = res.income.filter((x) => inYear(x.at));
  for (const kind of ['interest', 'reward'] as const) {
    const t = inc.filter((x) => x.kind === kind).reduce((s, x) => s + x.valueMicro, 0n);
    out.push(`Income (${kind}): $${fmtUsd(t)}  (${inc.filter((x) => x.kind === kind).length} items)`);
  }
  const fees = res.expenses.filter((x) => inYear(x.at));
  for (const kind of ['network_fee', 'borrow_interest'] as const) {
    const t = fees.filter((x) => x.kind === kind).reduce((s, x) => s + x.valueMicro, 0n);
    out.push(`Expense (${kind}): $${fmtUsd(t)}`);
  }
  out.push('Open balances: ' + (res.openBalances.map((b) => `${fmtUnits(b.units, 7)} ${symbolOf(b.asset)}`).join(', ') || 'none'));
  if (res.positions.length) {
    out.push('Open lending positions: ' + res.positions.map((p) => `${p.key.split(':')[2] ? symbolOf(p.key.split(':').slice(2).join(':')) : '?'} principal ${fmtUnits(p.principalUnits, 7)} (${p.shares} shares)`).join('; '));
  }
  const w = new Map<string, number>();
  for (const x of res.warnings) w.set(x.code, (w.get(x.code) ?? 0) + 1);
  out.push(w.size ? `Warnings: ${[...w].map(([k, v]) => `${k}=${v}`).join('  ')}` : 'Warnings: none');
  return out.join('\n');
}
