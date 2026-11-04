/**
 * Galexie public data lake reader (AWS Public Blockchain Dataset).
 * One LedgerCloseMeta per zstd file; layout and config verified against
 * https://aws-public-blockchain.s3.us-east-2.amazonaws.com/v1.1/stellar/ledgers/pubnet/.config.json
 * (ledgersPerBatch 1, batchesPerPartition 64000, zstd).
 *
 * Why this exists: Horizon (v30) no longer returns result_meta_xdr and Soroban RPC keeps
 * about 7 days, so contract events older than a week are only available from the lake.
 */
import zlib from 'node:zlib';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { Worker } from 'node:worker_threads';
import { StrKey, xdr } from '@stellar/stellar-sdk';
import type { RawEvent } from '../types.ts';
import { scNative, toHex } from '../util.ts';

const BASE = 'https://aws-public-blockchain.s3.us-east-2.amazonaws.com/v1.1/stellar/ledgers/pubnet';
const PARTITION = 64000;

const hex8 = (n: number): string => (0xffffffff - n).toString(16).toUpperCase().padStart(8, '0');

export function lakeUrl(ledger: number): string {
  const start = Math.floor(ledger / PARTITION) * PARTITION;
  return `${BASE}/${hex8(start)}--${start}-${start + PARTITION - 1}/${hex8(ledger)}--${ledger}.xdr.zst`;
}

export interface LakeTx {
  hash: string;
  applicationOrder: number;
  successful: boolean;
  feeCharged: bigint;
  events: RawEvent[];
}

export interface LakeLedger {
  ledger: number;
  closedAt: string;
  txs: Map<string, LakeTx>;
}

export interface LakeOptions {
  cacheDir?: string;
  fetchImpl?: typeof fetch;
}

type Bytesish = Uint8Array | { value: Uint8Array } | ArrayLike<number>;
const bytes = (b: unknown): Uint8Array => {
  const v = b as Bytesish;
  if (v instanceof Uint8Array) return v;
  if ((v as { value?: Uint8Array }).value instanceof Uint8Array) return (v as { value: Uint8Array }).value;
  return Uint8Array.from(v as ArrayLike<number>);
};

const enumName = (v: unknown): string =>
  typeof v === 'string' ? v : ((v as { name?: string })?.name ?? '');

function decodeEvent(
  e: any,
  ledger: number,
  txHash: string,
  opIndex: number | null,
  eventIndex: number,
): RawEvent {
  const body = e.body.v0;
  return {
    ledger,
    txHash,
    opIndex,
    eventIndex,
    contractId: e.contractId ? StrKey.encodeContract(Buffer.from(bytes(e.contractId))) : null,
    // XDR enums decode to objects ({ name, value }) in stellar-sdk 17.
    type: enumName(e.type) === 'contract' ? 'contract' : enumName(e.type) === 'diagnostic' ? 'diagnostic' : 'system',
    topics: (body.topics as xdr.ScVal[]).map(scNative),
    data: scNative(body.data as xdr.ScVal),
  };
}

export function decodeLedgerMeta(raw: Uint8Array, ledger: number): LakeLedger {
  const batch = xdr.LedgerCloseMetaBatch.fromXDR(raw as Buffer) as any;
  const lcm = batch.ledgerCloseMetas[0];
  const v = lcm[lcm.type];
  const closeTime = Number(v.ledgerHeader.header.scpValue.closeTime);
  const txs = new Map<string, LakeTx>();
  (v.txProcessing as any[]).forEach((tp, order) => {
    const hash = toHex(bytes(tp.result.transactionHash));
    const m = tp.txApplyProcessing;
    const inner = m[m.type];
    const events: RawEvent[] = [];
    let idx = 0;
    if (m.type === 'v4') {
      (inner.operations as any[]).forEach((op, opIndex) => {
        for (const ev of op.events as any[]) events.push(decodeEvent(ev, ledger, hash, opIndex, idx++));
      });
      // tx-level events are wrapped as { stage, event } (fee events, refunds).
      for (const w of (inner.events ?? []) as any[]) events.push(decodeEvent(w.event, ledger, hash, null, idx++));
    } else if (m.type === 'v3') {
      for (const ev of (inner.sorobanMeta?.events ?? []) as any[]) events.push(decodeEvent(ev, ledger, hash, 0, idx++));
    }
    const res = tp.result.result;
    const code: string = enumName(res.result?.type);
    txs.set(hash, {
      hash,
      applicationOrder: order,
      successful: code === 'txSuccess' || code === 'txFeeBumpInnerSuccess',
      feeCharged: BigInt(res.feeCharged ?? 0n),
      events,
    });
  });
  return { ledger, closedAt: new Date(closeTime * 1000).toISOString().replace('.000Z', 'Z'), txs };
}

/** Small pool of decode workers; falls back to inline decoding when threads are disabled. */
class DecodePool {
  private workers: { w: Worker; busy: boolean }[] = [];
  private queue: { job: any; resolve: (v: any) => void; reject: (e: Error) => void }[] = [];
  private pending = new Map<number, { resolve: (v: any) => void; reject: (e: Error) => void; slot: { w: Worker; busy: boolean } }>();
  private seq = 1;
  constructor(size: number) {
    for (let i = 0; i < size; i++) {
      const w = new Worker(new URL('./lake-worker.ts', import.meta.url));
      const slot = { w, busy: false };
      w.on('message', (m: any) => {
        const p = this.pending.get(m.id);
        if (!p) return;
        this.pending.delete(m.id);
        slot.busy = false;
        m.ok ? p.resolve(m) : p.reject(new Error(m.error));
        this.pump();
      });
      this.workers.push(slot);
    }
  }
  private pump(): void {
    for (const slot of this.workers) {
      if (slot.busy) continue;
      const next = this.queue.shift();
      if (!next) return;
      slot.busy = true;
      this.pending.set(next.job.id, { resolve: next.resolve, reject: next.reject, slot });
      slot.w.postMessage(next.job);
    }
  }
  run(ledger: number, raw: Uint8Array, wanted: string[] | null): Promise<{ ledger: number; closedAt: string; txs: LakeTx[] }> {
    return new Promise((resolve, reject) => {
      this.queue.push({ job: { id: this.seq++, ledger, raw, wanted }, resolve, reject });
      this.pump();
    });
  }
  async close(): Promise<void> {
    await Promise.all(this.workers.map((s) => s.w.terminate()));
  }
}

export class LakeSource {
  private cacheDir: string | undefined;
  private doFetch: typeof fetch;
  private pool: DecodePool | null;
  constructor(opts: LakeOptions & { threads?: number } = {}) {
    this.cacheDir = opts.cacheDir;
    this.doFetch = opts.fetchImpl ?? fetch;
    if (this.cacheDir) fs.mkdirSync(this.cacheDir, { recursive: true });
    const n = opts.threads ?? Math.max(1, Math.min(os.availableParallelism() - 1, 8));
    this.pool = n > 0 ? new DecodePool(n) : null;
  }
  async close(): Promise<void> {
    await this.pool?.close();
  }

  /** Download, cache and decode a ledger. `wanted` limits the returned transactions (smaller IPC, same decode cost). */
  async getLedger(ledger: number, wanted?: Iterable<string>): Promise<LakeLedger> {
    const cached = this.cacheDir ? path.join(this.cacheDir, `${ledger}.xdr.zst`) : undefined;
    let comp: Buffer | undefined;
    if (cached && fs.existsSync(cached)) comp = fs.readFileSync(cached);
    if (!comp) {
      let lastErr: unknown;
      for (let attempt = 0; attempt < 4; attempt++) {
        try {
          const res = await this.doFetch(lakeUrl(ledger));
          if (res.status === 404) throw new Error(`ledger ${ledger} not in lake yet (404)`);
          if (!res.ok) throw new Error(`lake HTTP ${res.status} for ledger ${ledger}`);
          comp = Buffer.from(await res.arrayBuffer());
          break;
        } catch (e) {
          lastErr = e;
          if (String((e as Error).message).includes('404')) throw e;
          await new Promise((r) => setTimeout(r, 400 * 2 ** attempt));
        }
      }
      if (!comp) throw lastErr;
      if (cached) fs.writeFileSync(cached, comp);
    }
    const raw = zlib.zstdDecompressSync(comp);
    if (!this.pool) return decodeLedgerMeta(raw, ledger);
    const r = await this.pool.run(ledger, raw, wanted ? [...wanted] : null);
    return { ledger: r.ledger, closedAt: r.closedAt, txs: new Map(r.txs.map((t) => [t.hash, t])) };
  }
}
