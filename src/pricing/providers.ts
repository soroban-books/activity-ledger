import fs from 'node:fs';
import type { PricePoint, PriceProvider } from './types.ts';

/** Assets assumed to be worth exactly 1 USD. Explicit, small and auditable: depegs are NOT modelled. */
export const USD_PEGGED = new Set<string>([
  'USDC:GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN',
]);

export class PegProvider implements PriceProvider {
  private pegged: Set<string>;
  constructor(pegged: Set<string> = USD_PEGGED) {
    this.pegged = pegged;
  }
  async price(asset: string): Promise<PricePoint | null> {
    return this.pegged.has(asset) ? { micro: 1_000_000n, source: 'peg' } : null;
  }
}

/** Manual overrides from a CSV: asset,iso_time_prefix,usd_price  (prefix match, longest wins). */
export class ManualProvider implements PriceProvider {
  private rows: { asset: string; prefix: string; micro: bigint }[] = [];
  constructor(csvPath?: string) {
    if (csvPath && fs.existsSync(csvPath)) {
      for (const line of fs.readFileSync(csvPath, 'utf8').split(/\r?\n/).slice(1)) {
        const [asset, prefix, usd] = line.split(',');
        if (asset && prefix && usd) this.rows.push({ asset, prefix, micro: BigInt(Math.round(Number(usd) * 1e6)) });
      }
    }
  }
  async price(asset: string, at: string): Promise<PricePoint | null> {
    const hit = this.rows
      .filter((r) => r.asset === asset && at.startsWith(r.prefix))
      .sort((a, b) => b.prefix.length - a.prefix.length)[0];
    return hit ? { micro: hit.micro, source: 'manual' } : null;
  }
}

const USDC = 'USDC:GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN';

/**
 * Price from SDEX hourly trade aggregates on Horizon (free, no key, about 1 year of history).
 * asset -> USDC directly, else asset -> XLM -> USDC. Soroban AMM-only assets are NOT priced here.
 */
export class SdexProvider implements PriceProvider {
  private cache = new Map<string, bigint | null>();
  private base: string;
  private doFetch: typeof fetch;
  constructor(base = 'https://horizon.stellar.org', doFetch: typeof fetch = fetch) {
    this.base = base;
    this.doFetch = doFetch;
  }

  private param(prefix: string, asset: string): string {
    if (asset === 'native') return `${prefix}_asset_type=native`;
    const [code, issuer] = asset.split(':');
    if (!code || !issuer) return '';
    const type = code.length <= 4 ? 'credit_alphanum4' : 'credit_alphanum12';
    return `${prefix}_asset_type=${type}&${prefix}_asset_code=${code}&${prefix}_asset_issuer=${issuer}`;
  }

  private async hourly(base: string, counter: string, hourStartMs: number): Promise<bigint | null> {
    const key = `${base}|${counter}|${hourStartMs}`;
    if (this.cache.has(key)) return this.cache.get(key)!;
    const bp = this.param('base', base);
    const cp = this.param('counter', counter);
    let result: bigint | null = null;
    if (bp && cp) {
      // Look back up to 24h for the most recent traded hour at or before the target.
      const url = `${this.base}/trade_aggregations?${bp}&${cp}&resolution=3600000&start_time=${hourStartMs - 86_400_000}&end_time=${hourStartMs + 3_600_000}&order=desc&limit=1`;
      try {
        const res = await this.doFetch(url);
        if (res.ok) {
          const rec = ((await res.json()) as any)._embedded?.records?.[0];
          if (rec?.close) {
            const n = rec.close_r?.n;
            const d = rec.close_r?.d;
            result = n && d && BigInt(d) > 0n ? (BigInt(n) * 1_000_000n) / BigInt(d) : BigInt(Math.round(Number(rec.close) * 1e6));
          }
        }
      } catch {
        result = null;
      }
    }
    this.cache.set(key, result);
    return result;
  }

  async price(asset: string, at: string): Promise<PricePoint | null> {
    const ms = Date.parse(at);
    if (Number.isNaN(ms)) return null;
    const hour = Math.floor(ms / 3_600_000) * 3_600_000;
    const direct = await this.hourly(asset, USDC, hour);
    if (direct !== null) return { micro: direct, source: 'sdex-1h' };
    if (asset === 'native') return null;
    const inXlm = await this.hourly(asset, 'native', hour);
    const xlmUsd = inXlm === null ? null : await this.hourly('native', USDC, hour);
    if (inXlm !== null && xlmUsd !== null) return { micro: (inXlm * xlmUsd) / 1_000_000n, source: 'sdex-1h-via-xlm' };
    return null;
  }
}

/** First provider that answers wins. */
export class CompositeProvider implements PriceProvider {
  private providers: PriceProvider[];
  constructor(providers: PriceProvider[]) {
    this.providers = providers;
  }
  async price(asset: string, at: string): Promise<PricePoint | null> {
    for (const p of this.providers) {
      const r = await p.price(asset, at);
      if (r) return r;
    }
    return null;
  }
}
