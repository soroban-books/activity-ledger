/**
 * Asset identity. Canonical key is 'native' or 'CODE:ISSUER' when the asset is a Stellar Asset
 * Contract (SAC); any other token keeps its contract id (C...). The SAC contract id -> classic
 * asset mapping is learned from CAP-67 events (their 4th topic carries the classic asset string)
 * and seeded with the assets every Soroban DeFi protocol touches.
 */
import type { RawEvent } from './types.ts';

export const SEED_SAC: Record<string, string> = {
  CAS3J7GYLGXMF6TDJBBYYSE3HQ6BBSMLNUQ34T6TZMYMW2EVH34XOWMA: 'native',
  CCW67TSZV3SSS2HXMBQ5JFGCKJNXKZM7UQUWUZPUTHXSTZLEO7SJMI75:
    'USDC:GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN',
  CD25MNVTZDL4Y3XBCPCJXGXATV5WUHHOWMYFF4YBEGU5FCPGMYTVG5JY:
    'BLND:GDJEHTBE6ZHUXSWFI642DCGLUOECLHPF3KSXHPXTSTJ7E3JF6MQ5EZYY',
};

export class AssetRegistry {
  private sac = new Map<string, string>(Object.entries(SEED_SAC));
  private decimals = new Map<string, number>();

  /** Learn contract -> classic asset from any event whose 4th topic is an asset string. */
  learn(events: RawEvent[]): void {
    for (const e of events) {
      const t3 = e.topics[3];
      if (e.contractId && typeof t3 === 'string' && (t3 === 'native' || t3.includes(':'))) {
        this.sac.set(e.contractId, t3);
      }
    }
  }

  /** Map a contract id to its canonical asset key (identity if not a known SAC). */
  canonical(contractOrAsset: string): string {
    return this.sac.get(contractOrAsset) ?? contractOrAsset;
  }

  /** SACs always use 7 decimals; other SEP-41 tokens default to 7 unless configured. */
  decimalsOf(asset: string): number {
    return this.decimals.get(asset) ?? 7;
  }
  setDecimals(asset: string, d: number): void {
    this.decimals.set(asset, d);
  }
  snapshot(): Record<string, string> {
    return Object.fromEntries(this.sac);
  }
  load(map: Record<string, string>): void {
    for (const [k, v] of Object.entries(map)) this.sac.set(k, v);
  }
}

export const symbolOf = (asset: string): string =>
  asset === 'native' ? 'XLM' : asset.includes(':') ? asset.split(':')[0]! : `${asset.slice(0, 4)}…${asset.slice(-4)}`;
