/**
 * Minimal Soroban RPC client over the resilient HTTP layer (the SDK's client uses fetch, which
 * times out on slow links). Several public endpoints are tried in order because each one is
 * sometimes unreachable: mainnet.sorobanrpc.com is IPv6-only, so it fails on IPv4-only machines.
 * Public RPC keeps only about 7 days of events and the current ledger state, never history.
 */
import { httpPostJson } from './net.ts';

export const RPC_URLS = [
  'https://soroban-rpc.creit.tech',
  'https://rpc.ankr.com/stellar_soroban',
  'https://soroban-rpc.mainnet.stellar.gateway.fm',
  'https://mainnet.sorobanrpc.com',
];

let id = 0;
export async function rpcCall<T = any>(method: string, params: unknown, urls: string[] = RPC_URLS): Promise<T> {
  let lastErr: unknown;
  for (const url of urls) {
    try {
      const res = await httpPostJson(url, { jsonrpc: '2.0', id: ++id, method, params });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const body = await res.json();
      if (body.error) throw new Error(body.error.message ?? JSON.stringify(body.error));
      return body.result as T;
    } catch (e) {
      lastErr = e;
    }
  }
  throw new Error(`RPC ${method} failed on all endpoints: ${(lastErr as Error)?.message ?? lastErr}`);
}
