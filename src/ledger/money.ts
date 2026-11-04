/**
 * Fixed-point money. Base-unit amounts are bigint; USD values are integer micro-USD (1e-6)
 * so no floating point touches a cost basis or gain.
 */
export type Micro = bigint;

const pow10 = (n: number): bigint => 10n ** BigInt(n);

/** value (micro-USD) of `units` base units at `priceMicro` micro-USD per whole unit. Rounds half away from zero. */
export function valueMicro(units: bigint, decimals: number, priceMicro: Micro): Micro {
  const num = units * priceMicro;
  const den = pow10(decimals);
  const q = num / den;
  const r = num % den;
  return (r < 0n ? -r : r) * 2n >= den ? (num < 0n ? q - 1n : q + 1n) : q;
}

/** Proportional split: floor(total * part / whole), exact for bigint. */
export const prorate = (total: bigint, part: bigint, whole: bigint): bigint => (whole === 0n ? 0n : (total * part) / whole);

export function fmtUnits(units: bigint, decimals: number): string {
  const neg = units < 0n;
  const abs = neg ? -units : units;
  const s = abs.toString().padStart(decimals + 1, '0');
  const int = s.slice(0, s.length - decimals);
  const frac = decimals ? s.slice(s.length - decimals).replace(/0+$/, '') : '';
  return `${neg ? '-' : ''}${int}${frac ? '.' + frac : ''}`;
}

export const fmtUsd = (m: Micro): string => fmtUnits(m, 6);
