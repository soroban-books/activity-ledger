/**
 * HTTP client for Horizon and the lake. Node's built-in fetch has a fixed 10 s connect timeout
 * and no keep-alive tuning, which fails on slow links (observed: ~1 s round trip, ~25 KB/s per
 * connection). This uses a shared keep-alive agent, explicit timeouts, gzip/br decoding and
 * retries with backoff for network errors, 429 and 5xx. 4xx (including 404) is returned as is.
 */
import https from 'node:https';
import http from 'node:http';
import zlib from 'node:zlib';

export interface FetchedResponse {
  ok: boolean;
  status: number;
  json(): Promise<any>;
  arrayBuffer(): Promise<ArrayBuffer>;
}
export type Fetcher = (url: string) => Promise<FetchedResponse>;

const httpsAgent = new https.Agent({ keepAlive: true, maxSockets: 48, timeout: 120_000 });
const httpAgent = new http.Agent({ keepAlive: true, maxSockets: 48 });

function once(url: string, timeoutMs: number): Promise<{ status: number; body: Buffer }> {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const mod = u.protocol === 'http:' ? http : https;
    const req = mod.get(
      u,
      { agent: u.protocol === 'http:' ? httpAgent : httpsAgent, headers: { 'accept-encoding': 'gzip, br', 'user-agent': 'activity-ledger' } },
      (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (c: Buffer) => chunks.push(c));
        res.on('error', reject);
        res.on('end', () => {
          let body = Buffer.concat(chunks);
          try {
            const enc = res.headers['content-encoding'];
            if (enc === 'gzip') body = zlib.gunzipSync(body);
            else if (enc === 'br') body = zlib.brotliDecompressSync(body);
          } catch (e) {
            return reject(e);
          }
          resolve({ status: res.statusCode ?? 0, body });
        });
      },
    );
    req.setTimeout(timeoutMs, () => req.destroy(new Error(`timeout after ${timeoutMs} ms: ${u.host}${u.pathname.slice(0, 40)}`)));
    req.on('error', reject);
  });
}

export const httpFetch: Fetcher = async (url, retries = 5, timeoutMs = 90_000) => {
  let lastErr: unknown;
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      const { status, body } = await once(url, timeoutMs);
      if (status === 429 || status >= 500) throw new Error(`HTTP ${status}`);
      return {
        ok: status >= 200 && status < 300,
        status,
        json: async () => JSON.parse(body.toString('utf8')),
        arrayBuffer: async () => body.buffer.slice(body.byteOffset, body.byteOffset + body.byteLength) as ArrayBuffer,
      };
    } catch (e) {
      lastErr = e;
      if (attempt < retries) await new Promise((r) => setTimeout(r, Math.min(8000, 500 * 2 ** attempt) + Math.random() * 250));
    }
  }
  throw new Error(`network error for ${new URL(url).host}: ${(lastErr as Error)?.message ?? lastErr}`);
};
