/** Tax-lot book per asset. FIFO (default), LIFO or HIFO. All amounts base units, all USD micro-USD. */
import type { Micro } from './money.ts';
import { prorate } from './money.ts';

export type LotMethod = 'FIFO' | 'LIFO' | 'HIFO';

export interface Lot {
  id: number;
  asset: string;
  units: bigint; // remaining
  basisMicro: Micro; // remaining basis
  acquiredAt: string;
  /** Where the lot came from, for audit: 'transfer_in' | 'trade' | 'lend_withdraw' | 'interest_income' ... */
  origin: string;
}

export interface Disposal {
  asset: string;
  units: bigint;
  basisMicro: Micro;
  proceedsMicro: Micro;
  gainMicro: Micro;
  acquiredAt: string;
  disposedAt: string;
  longTerm: boolean; // held > 365 days
  lotId: number;
}

/** Units taken from lots without realising a gain (e.g. moving principal into a lending position). */
export interface Carry {
  asset: string;
  units: bigint;
  basisMicro: Micro;
  acquiredAt: string;
}

const DAY = 86_400_000;

export class LotBook {
  private lots = new Map<string, Lot[]>();
  private seq = 1;
  method: LotMethod;
  constructor(method: LotMethod = 'FIFO') {
    this.method = method;
  }

  acquire(asset: string, units: bigint, basisMicro: Micro, at: string, origin: string): Lot | null {
    if (units <= 0n) return null;
    const lot: Lot = { id: this.seq++, asset, units, basisMicro, acquiredAt: at, origin };
    const arr = this.lots.get(asset) ?? [];
    arr.push(lot);
    this.lots.set(asset, arr);
    return lot;
  }

  private order(asset: string): Lot[] {
    const arr = (this.lots.get(asset) ?? []).filter((l) => l.units > 0n);
    if (this.method === 'LIFO') return [...arr].reverse();
    if (this.method === 'HIFO') {
      return [...arr].sort((a, b) => Number((b.basisMicro * a.units - a.basisMicro * b.units) / (a.units * b.units || 1n)));
    }
    return arr; // acquisition order
  }

  balance(asset: string): bigint {
    return (this.lots.get(asset) ?? []).reduce((s, l) => s + l.units, 0n);
  }
  assets(): string[] {
    return [...this.lots.keys()].filter((a) => this.balance(a) > 0n);
  }
  openLots(asset: string): Lot[] {
    return (this.lots.get(asset) ?? []).filter((l) => l.units > 0n).map((l) => ({ ...l }));
  }

  /** Consume `units` and return the pieces. Shortfall (no lots) is reported, never silently ignored. */
  private take(asset: string, units: bigint): { pieces: { lot: Lot; units: bigint; basis: Micro }[]; shortfall: bigint } {
    let need = units;
    const pieces: { lot: Lot; units: bigint; basis: Micro }[] = [];
    for (const lot of this.order(asset)) {
      if (need === 0n) break;
      const u = lot.units < need ? lot.units : need;
      const b = u === lot.units ? lot.basisMicro : prorate(lot.basisMicro, u, lot.units);
      pieces.push({ lot: { ...lot }, units: u, basis: b });
      lot.units -= u;
      lot.basisMicro -= b;
      need -= u;
    }
    return { pieces, shortfall: need };
  }

  dispose(asset: string, units: bigint, proceedsMicro: Micro, at: string): { disposals: Disposal[]; shortfall: bigint } {
    const { pieces, shortfall } = this.take(asset, units);
    const disposals: Disposal[] = [];
    let allocated = 0n;
    pieces.forEach((p, i) => {
      const last = i === pieces.length - 1 && shortfall === 0n;
      const share = last ? proceedsMicro - allocated : prorate(proceedsMicro, p.units, units);
      allocated += share;
      disposals.push({
        asset, units: p.units, basisMicro: p.basis, proceedsMicro: share, gainMicro: share - p.basis,
        acquiredAt: p.lot.acquiredAt, disposedAt: at,
        longTerm: Date.parse(at) - Date.parse(p.lot.acquiredAt) > 365 * DAY, lotId: p.lot.id,
      });
    });
    return { disposals, shortfall };
  }

  /** Remove units without a gain, returning their basis and acquisition dates (position deposits). */
  carryOut(asset: string, units: bigint): { carries: Carry[]; shortfall: bigint } {
    const { pieces, shortfall } = this.take(asset, units);
    return {
      carries: pieces.map((p) => ({ asset, units: p.units, basisMicro: p.basis, acquiredAt: p.lot.acquiredAt })),
      shortfall,
    };
  }
}
