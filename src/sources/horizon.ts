/**
 * Horizon is used only to DISCOVER which transactions touch an account and to read the envelope
 * (source, ops, invoked contract/function). Events come from the lake (Horizon v30 no longer
 * returns result_meta_xdr). Horizon keeps about one year of history.
 */
import { Address, Networks, StrKey, TransactionBuilder } from '@stellar/stellar-sdk';
import { httpFetch, type Fetcher } from './net.ts';

export interface HorizonTx {
  hash: string;
  ledger: number;
  createdAt: string;
  sourceAccount: string;
  feeAccount: string;
  successful: boolean;
  feeCharged: bigint;
  memo: string | null;
  opTypes: string[];
  invokedContracts: string[];
  invokedFunctions: string[];
  pagingToken: string;
}

export interface HorizonOptions {
  baseUrl?: string;
  fetchImpl?: Fetcher;
  /** Fixed page size. Default: ramp 25, 100, 200 so the first lake downloads start early. */
  pageSize?: number;
}

export function parseEnvelope(envelopeXdr: string): Pick<HorizonTx, 'opTypes' | 'invokedContracts' | 'invokedFunctions'> {
  const res = { opTypes: [] as string[], invokedContracts: [] as string[], invokedFunctions: [] as string[] };
  try {
    const parsed = TransactionBuilder.fromXDR(envelopeXdr, Networks.PUBLIC) as any;
    const inner = parsed.innerTransaction ?? parsed;
    for (const op of inner.operations as any[]) {
      res.opTypes.push(op.type);
      if (op.type === 'invokeHostFunction') {
        const f = op.func;
        const ic = f?.invokeContract ?? (typeof f?.invokeContract === 'function' ? f.invokeContract() : undefined);
        if (ic) {
          const addr = ic.contractAddress ?? ic.contractAddress?.();
          try {
            res.invokedContracts.push(Address.fromScAddress(addr).toString());
          } catch {
            res.invokedContracts.push('?');
          }
          const fn = ic.functionName;
          // The SDK returns an XDR string wrapper here (not bytes); String() yields the symbol.
          res.invokedFunctions.push(fn instanceof Uint8Array ? Buffer.from(fn).toString() : String(fn));
        }
      }
    }
  } catch {
    /* envelope metadata is best-effort */
  }
  return res;
}

export async function* accountTransactions(
  account: string,
  opts: HorizonOptions & { cursor?: string; limit?: number } = {},
): AsyncGenerator<HorizonTx> {
  if (!StrKey.isValidEd25519PublicKey(account)) throw new Error(`not a G... account: ${account}`);
  const base = opts.baseUrl ?? 'https://horizon.stellar.org';
  const doFetch = opts.fetchImpl ?? httpFetch;
  const ramp = opts.pageSize ? [opts.pageSize] : [25, 100, 200];
  let pageNo = 0;
  const sizeFor = (n: number): number => ramp[Math.min(n, ramp.length - 1)]!;

  const fetchPage = async (cursor: string, pageSize: number): Promise<any[]> => {
    const url = `${base}/accounts/${account}/transactions?order=asc&limit=${pageSize}&include_failed=true${cursor ? `&cursor=${cursor}` : ''}`;
    for (let attempt = 0; ; attempt++) {
      const res = await doFetch(url);
      if (res.ok) return ((await res.json())._embedded.records as any[]) ?? [];
      if (res.status === 404) throw new Error(`account ${account} not found on Horizon`);
      if (attempt >= 4) throw new Error(`Horizon ${res.status} for ${url}`);
      await new Promise((r) => setTimeout(r, 500 * 2 ** attempt));
    }
  };

  let emitted = 0;
  let next = fetchPage(opts.cursor ?? '', sizeFor(0));
  for (;;) {
    let records = await next;
    if (records.length === 0) return;
    let full = records.length >= sizeFor(pageNo);
    pageNo++;
    if (opts.limit && emitted + records.length >= opts.limit) {
      records = records.slice(0, opts.limit - emitted); // last page the caller wants: never prefetch another
      full = false;
    }
    let prefetched = !full;
    for (let i = 0; i < records.length; i++) {
      // Start the next page once the consumer is halfway through this one, so the round trip
      // overlaps with lake downloads, but nothing is fetched for a consumer that stops early.
      if (!prefetched && i >= records.length >> 1) {
        next = fetchPage(records[records.length - 1].paging_token, sizeFor(pageNo));
        next.catch(() => {});
        prefetched = true;
      }
      const r = records[i];
      emitted++;
      yield {
        hash: r.hash,
        ledger: r.ledger,
        createdAt: r.created_at,
        sourceAccount: r.source_account,
        feeAccount: r.fee_account,
        successful: r.successful,
        feeCharged: BigInt(r.fee_charged),
        memo: r.memo ?? null,
        pagingToken: r.paging_token,
        ...parseEnvelope(r.envelope_xdr),
      };
    }
    if (!full) return;
  }
}
