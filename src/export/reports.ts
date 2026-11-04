import type { LedgerEvent } from '../types.ts';
import type { EngineResult } from '../ledger/engine.ts';
import { fmtUnits, fmtUsd } from '../ledger/money.ts';
import { symbolOf } from '../assets.ts';
import { table } from './csv.ts';

export function eventsCsv(events: LedgerEvent[], res: EngineResult): string {
  return table(
    ['id', 'time', 'ledger', 'tx', 'kind', 'protocol', 'confidence', 'legs', 'usd_value_of_legs', 'counterparty', 'note'],
    events.map((e) => {
      const legs = res.pricedLegs.get(e.id) ?? [];
      const usd = legs.every((l) => l.valueMicro !== null)
        ? fmtUsd(legs.filter((l) => l.direction === 'in').reduce((s, l) => s + (l.valueMicro ?? 0n), 0n) ||
            legs.reduce((s, l) => s + (l.valueMicro ?? 0n), 0n))
        : '';
      return [
        e.id, e.closedAt, e.ledger, e.txHash, e.kind, e.protocol ?? '', e.confidence,
        e.legs.map((l) => `${l.direction}:${fmtUnits(l.amount, l.decimals)} ${symbolOf(l.asset)}`).join(' ; '),
        usd, e.counterparty ?? '', e.note,
      ];
    }),
  );
}

export function gainsCsv(res: EngineResult): string {
  return table(
    ['asset', 'units', 'acquired', 'disposed', 'proceeds_usd', 'basis_usd', 'gain_usd', 'term'],
    res.disposals.map((d) => [
      symbolOf(d.asset), fmtUnits(d.units, 7), d.acquiredAt, d.disposedAt,
      fmtUsd(d.proceedsMicro), fmtUsd(d.basisMicro), fmtUsd(d.gainMicro), d.longTerm ? 'long' : 'short',
    ]),
  );
}

export function incomeCsv(res: EngineResult): string {
  return table(
    ['time', 'kind', 'asset', 'units', 'usd_value', 'price_source', 'event'],
    res.income.map((i) => [i.at, i.kind, symbolOf(i.asset), fmtUnits(i.units, i.decimals), fmtUsd(i.valueMicro), i.priceSource, i.eventId]),
  );
}

/** Balanced double-entry journal: income, fees, borrow interest and realised gains. Amounts in USD. */
export function journalCsv(res: EngineResult): string {
  const rows: (string | number)[][] = [];
  const add = (date: string, account: string, dr: bigint, cr: bigint, memo: string, ref: string): void => {
    rows.push([date, account, dr ? fmtUsd(dr) : '', cr ? fmtUsd(cr) : '', memo, ref]);
  };
  for (const i of res.income) {
    const acct = `Assets:Crypto:${symbolOf(i.asset)}`;
    const inc = i.kind === 'interest' ? 'Income:Lending interest' : 'Income:Rewards';
    add(i.at, acct, i.valueMicro, 0n, `${i.kind} received`, i.eventId);
    add(i.at, inc, 0n, i.valueMicro, `${i.kind} received`, i.eventId);
  }
  for (const x of res.expenses) {
    const exp = x.kind === 'network_fee' ? 'Expenses:Network fees' : 'Expenses:Borrow interest';
    add(x.at, exp, x.valueMicro, 0n, x.kind, x.eventId);
    add(x.at, `Assets:Crypto:${symbolOf(x.asset)}`, 0n, x.valueMicro, x.kind, x.eventId);
  }
  for (const d of res.disposals) {
    const acct = `Assets:Crypto:${symbolOf(d.asset)}`;
    add(d.disposedAt, 'Clearing:Disposal proceeds', d.proceedsMicro, 0n, `disposal of ${symbolOf(d.asset)}`, `lot${d.lotId}`);
    add(d.disposedAt, acct, 0n, d.basisMicro, 'basis released', `lot${d.lotId}`);
    if (d.gainMicro > 0n) add(d.disposedAt, 'Gains:Realized', 0n, d.gainMicro, 'realized gain', `lot${d.lotId}`);
    else if (d.gainMicro < 0n) add(d.disposedAt, 'Gains:Realized', -d.gainMicro, 0n, 'realized loss', `lot${d.lotId}`);
  }
  rows.sort((a, b) => String(a[0]).localeCompare(String(b[0])));
  return table(['date', 'account', 'debit_usd', 'credit_usd', 'memo', 'ref'], rows);
}
