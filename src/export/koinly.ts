/**
 * Koinly "Universal Template" CSV.
 * Header and the date format follow Koinly's published universal import template.
 * The LABELS below are my best mapping and have NOT been verified against a live Koinly import:
 * adjust them here after the first real import (see docs/EXPORTS.md, "Koinly verification").
 * Principal moves into/out of a lending position are deliberately omitted (non-taxable carryover);
 * only the interest/reward income they generate is exported.
 */
import type { LedgerEvent } from '../types.ts';
import type { PricedLeg } from '../ledger/engine.ts';
import { fmtUnits, fmtUsd } from '../ledger/money.ts';
import { symbolOf } from '../assets.ts';
import { table } from './csv.ts';

export const LABELS = {
  interest: 'reward',
  reward: 'reward',
  lpIn: 'liquidity in',
  lpOut: 'liquidity out',
  fee: 'cost',
} as const;

export const KOINLY_HEADER = [
  'Date', 'Sent Amount', 'Sent Currency', 'Received Amount', 'Received Currency',
  'Fee Amount', 'Fee Currency', 'Net Worth Amount', 'Net Worth Currency', 'Label', 'Description', 'TxHash',
];

export const koinlyDate = (iso: string): string => iso.replace('T', ' ').replace('Z', ' UTC');

interface InterestRow { eventId: string; at: string; asset: string; units: bigint; decimals: number; valueMicro: bigint; kind: 'interest' | 'reward' }

export function koinlyCsv(
  events: LedgerEvent[],
  priced: Map<string, PricedLeg[]>,
  income: InterestRow[],
): string {
  const rows: (string | number | bigint)[][] = [];
  const feeByTx = new Map<string, { units: bigint; asset: string; decimals: number }>();
  for (const e of events) if (e.kind === 'fee' && e.legs[0]) feeByTx.set(e.txHash, { units: e.legs[0].amount, asset: e.legs[0].asset, decimals: e.legs[0].decimals });
  const feeUsed = new Set<string>();
  const feeCells = (tx: string): [string, string] => {
    const f = feeByTx.get(tx);
    if (!f || feeUsed.has(tx)) return ['', ''];
    feeUsed.add(tx);
    return [fmtUnits(f.units, f.decimals), symbolOf(f.asset)];
  };
  const worth = (legs: PricedLeg[]): string => {
    let t = 0n;
    for (const l of legs) { if (l.valueMicro === null) return ''; t += l.valueMicro; }
    return fmtUsd(t);
  };
  const cur = (a: string): string => symbolOf(a);
  const amt = (l: { amount: bigint; decimals: number }): string => fmtUnits(l.amount, l.decimals);

  for (const e of events) {
    const legs = priced.get(e.id) ?? [];
    const outs = legs.filter((l) => l.direction === 'out');
    const ins = legs.filter((l) => l.direction === 'in');
    const date = koinlyDate(e.closedAt);
    switch (e.kind) {
      case 'transfer_in': case 'mint':
        for (const l of ins) rows.push([date, '', '', amt(l), cur(l.asset), '', '', worth([l]), 'USD', '', e.note || e.counterparty || '', e.txHash]);
        break;
      case 'transfer_out': case 'burn':
        for (const l of outs) { const [fa, fc] = feeCells(e.txHash); rows.push([date, amt(l), cur(l.asset), '', '', fa, fc, worth([l]), 'USD', '', e.note || e.counterparty || '', e.txHash]); }
        break;
      case 'trade': {
        const n = Math.max(outs.length, ins.length);
        for (let i = 0; i < n; i++) {
          const o = outs[i]; const r = ins[i];
          const [fa, fc] = i === 0 ? feeCells(e.txHash) : ['', ''];
          rows.push([date, o ? amt(o) : '', o ? cur(o.asset) : '', r ? amt(r) : '', r ? cur(r.asset) : '', fa, fc, worth([o, r].filter(Boolean) as PricedLeg[]), 'USD', '', `${e.protocol ?? 'trade'}: ${e.note}`, e.txHash]);
        }
        break;
      }
      case 'lp_add': case 'vault_deposit': {
        const [fa, fc] = feeCells(e.txHash);
        outs.forEach((o, i) => rows.push([date, amt(o), cur(o.asset), i === 0 && ins[0] ? amt(ins[0]) : '', i === 0 && ins[0] ? cur(ins[0].asset) : '', i === 0 ? fa : '', i === 0 ? fc : '', worth([o]), 'USD', LABELS.lpIn, e.note, e.txHash]));
        break;
      }
      case 'lp_remove': case 'vault_withdraw': {
        const [fa, fc] = feeCells(e.txHash);
        ins.forEach((r, i) => rows.push([date, i === 0 && outs[0] ? amt(outs[0]) : '', i === 0 && outs[0] ? cur(outs[0].asset) : '', amt(r), cur(r.asset), i === 0 ? fa : '', i === 0 ? fc : '', worth([r]), 'USD', LABELS.lpOut, e.note, e.txHash]));
        break;
      }
      default:
        break; // lend_*, borrow, repay, fee, unclassified handled elsewhere
    }
  }
  const evTx = new Map(events.map((e) => [e.id, e.txHash]));
  for (const i of income) {
    rows.push([koinlyDate(i.at), '', '', fmtUnits(i.units, i.decimals), symbolOf(i.asset), '', '', fmtUsd(i.valueMicro), 'USD', i.kind === 'interest' ? LABELS.interest : LABELS.reward, `${i.kind} income`, evTx.get(i.eventId) ?? '']);
  }
  // fee-only transactions (e.g. failed txs or contract calls with no asset movement)
  for (const [tx, f] of feeByTx) {
    if (feeUsed.has(tx)) continue;
    const e = events.find((x) => x.txHash === tx && x.kind === 'fee')!;
    rows.push([koinlyDate(e.closedAt), '', '', '', '', fmtUnits(f.units, f.decimals), symbolOf(f.asset), '', 'USD', LABELS.fee, e.note, tx]);
  }
  rows.sort((a, b) => String(a[0]).localeCompare(String(b[0])));
  return table(KOINLY_HEADER, rows);
}
