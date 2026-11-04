/** Turns CAP-67 events of one transaction into per-account asset flows. */
import type { RawEvent, RawTx } from '../types.ts';
import type { AssetRegistry } from '../assets.ts';

export interface Flow {
  eventIndex: number;
  opIndex: number | null;
  kind: 'transfer' | 'mint' | 'burn' | 'clawback';
  asset: string;
  assetContract: string | null;
  from: string | null;
  to: string | null;
  amount: bigint;
  muxedId?: string;
}

const asBigInt = (v: unknown): bigint | null => {
  if (typeof v === 'bigint') return v;
  if (typeof v === 'number' && Number.isFinite(v)) return BigInt(Math.trunc(v));
  if (typeof v === 'string' && /^-?\d+$/.test(v)) return BigInt(v);
  return null;
};

/** CAP-67 allows the data to be a bare i128 or a map { amount, to_muxed_id }. */
function readAmount(data: unknown): { amount: bigint; muxedId?: string } | null {
  const direct = asBigInt(data);
  if (direct !== null) return { amount: direct };
  if (data && typeof data === 'object') {
    const d = data as Record<string, unknown>;
    const a = asBigInt(d.amount);
    if (a !== null) return { amount: a, muxedId: d.to_muxed_id == null ? undefined : String(d.to_muxed_id) };
  }
  return null;
}

export function extractFlows(tx: RawTx, reg: AssetRegistry): Flow[] {
  const out: Flow[] = [];
  for (const e of tx.events) {
    if (e.type !== 'contract') continue;
    const name = e.topics[0];
    if (name !== 'transfer' && name !== 'mint' && name !== 'burn' && name !== 'clawback') continue;
    const amt = readAmount(e.data);
    // Zero-amount movements (dust probes, account-creation placeholders) carry no value: skip.
    if (!amt || amt.amount === 0n) continue;
    const t = e.topics;
    const str = (v: unknown): string | null => (typeof v === 'string' ? v : null);
    let from: string | null = null;
    let to: string | null = null;
    let assetTopic: unknown;
    if (name === 'transfer') {
      from = str(t[1]);
      to = str(t[2]);
      assetTopic = t[3];
    } else if (name === 'mint') {
      to = str(t[1]);
      assetTopic = t[2];
    } else if (name === 'burn' || name === 'clawback') {
      from = str(t[1]);
      assetTopic = t[2];
    }
    const assetStr = typeof assetTopic === 'string' ? assetTopic : null;
    const asset = assetStr ?? reg.canonical(e.contractId ?? 'unknown');
    out.push({
      eventIndex: e.eventIndex,
      opIndex: e.opIndex,
      kind: name,
      asset,
      assetContract: e.contractId,
      from,
      to,
      amount: amt.amount,
      muxedId: amt.muxedId,
    });
  }
  return out;
}

/** Net network fee paid by `account` in stroops: fee events are a charge then a (negative) refund. */
export function netFee(events: RawEvent[], account: string): bigint {
  let fee = 0n;
  for (const e of events) {
    if (e.type === 'contract' && e.topics[0] === 'fee' && e.topics[1] === account) {
      const a = asBigInt(e.data);
      if (a !== null) fee += a;
    }
  }
  return fee;
}
