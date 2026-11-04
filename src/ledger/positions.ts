/**
 * Lending position share ledger (Blend b-tokens). A position keeps the principal that went in
 * (units, basis, acquisition date) and the share balance. On withdrawal the burnt share fraction
 * releases that fraction of principal, and anything received beyond it is realised interest.
 * Interest therefore needs no state read: tokens_out is in the withdraw event itself.
 */
import type { Carry } from './lots.ts';
import { prorate } from './money.ts';

export interface Position {
  key: string; // `${protocol}:${pool}:${asset}`
  shares: bigint;
  principalUnits: bigint;
  carries: Carry[];
}

export interface Release {
  principalUnits: bigint;
  /** Tokens received beyond the principal of the shares we saw deposited (may be negative). */
  interestUnits: bigint;
  /** Tokens paid for shares whose deposit predates the sync window: basis unknown, flagged. */
  unknownUnits: bigint;
  carries: Carry[]; // principal returned to the wallet with original basis and dates
  shareShortfall: bigint;
}

export class Positions {
  private p = new Map<string, Position>();
  static key = (protocol: string, pool: string, asset: string): string => `${protocol}:${pool}:${asset}`;

  deposit(key: string, shares: bigint, tokens: bigint, carries: Carry[]): void {
    const pos = this.p.get(key) ?? { key, shares: 0n, principalUnits: 0n, carries: [] };
    pos.shares += shares;
    pos.principalUnits += tokens;
    pos.carries.push(...carries);
    this.p.set(key, pos);
  }

  /** Release the principal attributable to `burnt` shares; `tokensOut` is what the pool paid. */
  withdraw(key: string, burnt: bigint, tokensOut: bigint): Release {
    const pos = this.p.get(key);
    if (!pos || pos.shares === 0n) {
      return { principalUnits: 0n, interestUnits: 0n, unknownUnits: tokensOut, carries: [], shareShortfall: burnt };
    }
    const useShares = burnt > pos.shares ? pos.shares : burnt;
    const shortfall = burnt - useShares;
    const principal = useShares === pos.shares ? pos.principalUnits : prorate(pos.principalUnits, useShares, pos.shares);
    // Take `principal` units from the position's carried lots in order.
    let need = principal;
    const out: Carry[] = [];
    for (const c of pos.carries) {
      if (need === 0n) break;
      if (c.units === 0n) continue;
      const u = c.units < need ? c.units : need;
      const b = u === c.units ? c.basisMicro : prorate(c.basisMicro, u, c.units);
      out.push({ asset: c.asset, units: u, basisMicro: b, acquiredAt: c.acquiredAt });
      c.units -= u;
      c.basisMicro -= b;
      need -= u;
    }
    pos.carries = pos.carries.filter((c) => c.units > 0n);
    pos.shares -= useShares;
    pos.principalUnits -= principal;
    // Shares never seen deposited (history older than the sync start) have unknown principal:
    // the tokens paid for them are returned flagged, not counted as interest.
    const tokensForKnown = burnt === 0n ? 0n : prorate(tokensOut, useShares, burnt);
    return {
      principalUnits: principal,
      interestUnits: tokensForKnown - principal,
      unknownUnits: tokensOut - tokensForKnown,
      carries: out,
      shareShortfall: shortfall,
    };
  }

  snapshot(): Position[] {
    return [...this.p.values()].filter((p) => p.shares > 0n).map((p) => ({ ...p, carries: p.carries.map((c) => ({ ...c })) }));
  }
}
