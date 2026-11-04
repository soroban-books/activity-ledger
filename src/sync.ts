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
  /** Parallel lake downloads per batch (default 8). */
  concurrency?: number;
  /** Horizon transactions grouped per batch before downloading (default 32). */
  batchSize?: number;
}

/** Run `fn` over items with at most `n` in flight; results keep input order. */
async function pool<T, R>(items: T[], n: number, fn: (x: T) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(n, items.length) }, async () => {
      for (;;) {
        const i = next++;
        if (i >= items.length) return;
        out[i] = await fn(items[i]!);
      }
    }),
  );
  return out;
}

/** Join Horizon's per-account transaction list with lake events, batch by batch. */
export async function syncAccount(account: string, opts: SyncOptions): Promise<{ txs: number; skipped: number }> {
  const lake = opts.lake ?? new LakeSource({ cacheDir: '.cache/lake' });
  const conc = opts.concurrency ?? 8;
  const batchSize = opts.batchSize ?? 32;
  let txs = 0;
  let skipped = 0;
  let seen = 0;
  let batch: HorizonTx[] = [];

  const flush = async (): Promise<void> => {
    if (batch.length === 0) return;
    const wantedBy = new Map<number, Set<string>>();
    for (const h of batch) (wantedBy.get(h.ledger) ?? wantedBy.set(h.ledger, new Set()).get(h.ledger)!).add(h.hash);
    const ledgers = [...wantedBy.keys()];
    const loaded = new Map<number, LakeLedger | Error>();
    await pool(ledgers, conc, async (l) => {
      try {
        loaded.set(l, await lake.getLedger(l, wantedBy.get(l)));
      } catch (e) {
        loaded.set(l, e as Error);
      }
    });
    for (const h of batch) {
      const L = loaded.get(h.ledger);
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
    batch = [];
  };

  for await (const h of accountTransactions(account, opts)) {
    if (opts.limit && seen >= opts.limit) break;
    seen++;
    batch.push(h);
    if (batch.length >= batchSize) await flush();
  }
  await flush();
  if (!opts.lake) await lake.close();
  return { txs, skipped };
}
