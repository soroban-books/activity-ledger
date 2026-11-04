import { scValToNative, type xdr } from '@stellar/stellar-sdk';

export const toHex = (b: Uint8Array): string => Buffer.from(b).toString('hex');

/** BigInt-safe JSON for debugging and fixtures. */
export const jsonSafe = (v: unknown): string =>
  JSON.stringify(v, (_k, x) => (typeof x === 'bigint' ? x.toString() : x));

export function scNative(v: xdr.ScVal): unknown {
  try {
    return scValToNative(v);
  } catch {
    return { unsupported: true };
  }
}

/** Fixture (de)serialisation: bigint <-> {"$big":"123"}. */
export const stringifyFixture = (v: unknown): string =>
  JSON.stringify(v, (_k, x) => (typeof x === 'bigint' ? { $big: x.toString() } : x), 2);
export const parseFixture = <T>(s: string): T =>
  JSON.parse(s, (_k, x) => (x && typeof x === 'object' && '$big' in x ? BigInt((x as { $big: string }).$big) : x)) as T;
