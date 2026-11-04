/**
 * Horizon is used only to DISCOVER which transactions touch an account and to read the envelope
 * (source, ops, invoked contract/function). Events come from the lake (Horizon v30 no longer
 * returns result_meta_xdr). Horizon keeps about one year of history.
 */
import { Address, Networks, StrKey, TransactionBuilder } from '@stellar/stellar-sdk';

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
  fetchImpl?: typeof fetch;
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
          res.invokedFunctions.push(typeof fn === 'string' ? fn : Buffer.from(fn as Uint8Array).toString());
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
  opts: HorizonOptions & { cursor?: string } = {},
): AsyncGenerator<HorizonTx> {
  if (!StrKey.isValidEd25519PublicKey(account)) throw new Error(`not a G... account: ${account}`);
  const base = opts.baseUrl ?? 'https://horizon.stellar.org';
  const doFetch = opts.fetchImpl ?? fetch;
  let cursor = opts.cursor ?? '';
  for (;;) {
    const url = `${base}/accounts/${account}/transactions?order=asc&limit=${opts.pageSize ?? 200}&include_failed=true${cursor ? `&cursor=${cursor}` : ''}`;
    let body: any;
    for (let attempt = 0; ; attempt++) {
      const res = await doFetch(url);
      if (res.ok) {
        body = await res.json();
        break;
      }
      if (res.status === 404) throw new Error(`account ${account} not found on Horizon`);
      if (attempt >= 4) throw new Error(`Horizon ${res.status} for ${url}`);
      await new Promise((r) => setTimeout(r, 500 * 2 ** attempt));
    }
    const records = body._embedded.records as any[];
    if (records.length === 0) return;
    for (const r of records) {
      const meta = parseEnvelope(r.envelope_xdr);
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
        ...meta,
      };
      cursor = r.paging_token;
    }
    if (records.length < (opts.pageSize ?? 200)) return;
  }
}
