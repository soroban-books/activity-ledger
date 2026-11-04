/** Worker: decode one ledger's XDR off the main thread (decode is CPU-bound, 4-8 s per ledger in the JS SDK). */
import { parentPort } from 'node:worker_threads';
import { decodeLedgerMeta } from './lake.ts';

interface Job { id: number; ledger: number; raw: Uint8Array; wanted: string[] | null }

parentPort!.on('message', (job: Job) => {
  try {
    const L = decodeLedgerMeta(job.raw, job.ledger);
    const want = job.wanted ? new Set(job.wanted) : null;
    const txs = [...L.txs.values()].filter((t) => !want || want.has(t.hash));
    parentPort!.postMessage({ id: job.id, ok: true, ledger: L.ledger, closedAt: L.closedAt, txs });
  } catch (e) {
    parentPort!.postMessage({ id: job.id, ok: false, error: (e as Error).message });
  }
});
