import type { RawTx } from './types.ts';
import { accountTransactions, type HorizonOptions, type HorizonTx } from './sources/horizon.ts';
import { LakeSource, type LakeLedger } from './sources/lake.ts';

export interface SyncOptions extends HorizonOptions {
  cursor?: string;
  lake?: LakeSource;
  /** Called for every transaction in ledger order. */
  onTx: (tx: RawTx, pagingToken: string) => void | Promise<void>;
  onSkip?: (h: HorizonTx, reason: string) => void;
  limit?: number;
  /** Parallel lake downloads per batch (default 8). More does not add throughput on a bandwidth-bound link and delays the first result. */
  concurrency?: number;
  /** Horizon transactions grouped per batch before downloading (default 40). */
  batchSize?: number;
}

/** Join Horizon's per-account transaction list with lake events, batch by batch. */
export async function syncAccount(account: string, opts: SyncOptions): Promise<{ txs: number; skipped: number }> {
  const lake = opts.lake ?? new LakeSource({ cacheDir: '.cache/lake' });
  const conc = opts.concurrency ?? 8;
  const batchSize = opts.batchSize ?? 40;
  let txs = 0;
  let skipped = 0;
  let seen = 0;
  let batch: HorizonTx[] = [];

  const flush = async (): Promise<void> => {
    if (batch.length === 0) return;
    const wantedBy = new Map<number, Set<string>>();
    for (const h of batch) (wantedBy.get(h.ledger) ?? wantedBy.set(h.ledger, new Set()).get(h.ledger)!).add(h.hash);
    const ledgers = [...wantedBy.keys()];
    // Downloads run `conc` at a time; transactions are emitted strictly in order as soon as
    // their ledger is ready, so progress shows early and the stored cursor never skips ahead.
    const slots = new Map<number, { promise: Promise<LakeLedger | Error>; resolve: (v: LakeLedger | Error) => void }>();
    for (const l of ledgers) {
      let resolve!: (v: LakeLedger | Error) => void;
      const promise = new Promise<LakeLedger | Error>((r) => (resolve = r));
      slots.set(l, { promise, resolve });
    }
    let nextLedger = 0;
    const runners = Array.from({ length: Math.min(conc, ledgers.length) }, async () => {
      for (;;) {
        const i = nextLedger++;
        if (i >= ledgers.length) return;
        const l = ledgers[i]!;
        try {
          slots.get(l)!.resolve(await lake.getLedger(l, wantedBy.get(l)));
        } catch (e) {
          slots.get(l)!.resolve(e as Error);
        }
      }
    });
    for (const h of batch) {
      const L = await slots.get(h.ledger)!.promise;
      if (!L || L instanceof Error) {
        skipped++;
        opts.onSkip?.(h, L instanceof Error ? L.message : 'ledger not loaded');
        continue;
      }
      const t = L.txs.get(h.hash);
      if (!t) {
        skipped++;
        opts.onSkip?.(h, 'transaction not found in lake ledger');
        continue;
      }
      await opts.onTx(
        {
          ledger: h.ledger, closedAt: L.closedAt, hash: h.hash, applicationOrder: t.applicationOrder,
          sourceAccount: h.sourceAccount, feeAccount: h.feeAccount, successful: h.successful,
          feeCharged: h.feeCharged, opTypes: h.opTypes, invokedContracts: h.invokedContracts,
          invokedFunctions: h.invokedFunctions, events: t.events,
        },
        h.pagingToken,
      );
      txs++;
    }
    await Promise.all(runners);
    batch = [];
  };

  // With a small limit, ask Horizon for exactly that many rows instead of a 200-row page.
  const pageSize = opts.pageSize ?? (opts.limit ? Math.min(opts.limit, 200) : undefined);
  for await (const h of accountTransactions(account, { ...opts, pageSize, limit: opts.limit })) {
    if (opts.limit && seen >= opts.limit) break;
    seen++;
    batch.push(h);
    if (batch.length >= batchSize) await flush();
  }
  await flush();
  if (!opts.lake) await lake.close();
  return { txs, skipped };
}
