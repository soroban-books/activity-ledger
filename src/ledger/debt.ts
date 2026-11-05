/**
 * Borrow position share ledger (Blend d-tokens), the mirror of positions.ts. A borrow records
 * the principal that came in and the d-tokens minted. A repay burns d-tokens; the burnt
 * fraction releases that fraction of principal and any tokens paid beyond it are borrow
 * interest. This replaces the old per-asset "principal first" model, which mis-timed interest on
 * partial repayments and mixed pools. Debt that predates the sync window is never guessed.
 */
import { prorate } from './money.ts';

export interface Debt {
  key: string; // `blend-debt:${pool}:${asset}`
  shares: bigint;
  principalUnits: bigint;
}

export interface DebtRelease {
  principalUnits: bigint;
  /** Tokens paid beyond the principal of the d-tokens we saw minted (never negative). */
  interestUnits: bigint;
  /** Tokens paid for d-tokens minted before the sync window: split unknown, flagged. */
  unknownUnits: bigint;
  shareShortfall: bigint;
}

export class Debts {
  private d = new Map<string, Debt>();

  borrow(key: string, shares: bigint, tokens: bigint): void {
    const debt = this.d.get(key) ?? { key, shares: 0n, principalUnits: 0n };
    debt.shares += shares;
    debt.principalUnits += tokens;
    this.d.set(key, debt);
  }

  repay(key: string, burnt: bigint, tokensPaid: bigint): DebtRelease {
    const debt = this.d.get(key);
    if (!debt || debt.shares === 0n) return { principalUnits: 0n, interestUnits: 0n, unknownUnits: tokensPaid, shareShortfall: burnt };
    const use = burnt > debt.shares ? debt.shares : burnt;
    const principal = use === debt.shares ? debt.principalUnits : prorate(debt.principalUnits, use, debt.shares);
    debt.shares -= use;
    debt.principalUnits -= principal;
    const paidForKnown = burnt === 0n ? 0n : prorate(tokensPaid, use, burnt);
    const interest = paidForKnown - principal;
    return {
      principalUnits: principal,
      interestUnits: interest > 0n ? interest : 0n,
      unknownUnits: tokensPaid - paidForKnown,
      shareShortfall: burnt - use,
    };
  }

  /** Debt removed without a cash payment (liquidation, write-off). Returns the principal it carried. */
  clear(key: string, shares: bigint): { principalUnits: bigint; shareShortfall: bigint } {
    const debt = this.d.get(key);
    if (!debt || debt.shares === 0n) return { principalUnits: 0n, shareShortfall: shares };
    const use = shares > debt.shares ? debt.shares : shares;
    const principal = use === debt.shares ? debt.principalUnits : prorate(debt.principalUnits, use, debt.shares);
    debt.shares -= use;
    debt.principalUnits -= principal;
    return { principalUnits: principal, shareShortfall: shares - use };
  }

  snapshot(): Debt[] {
    return [...this.d.values()].filter((x) => x.shares > 0n).map((x) => ({ ...x }));
  }
}
