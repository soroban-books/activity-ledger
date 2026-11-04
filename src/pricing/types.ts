import type { Micro } from '../ledger/money.ts';

export interface PricePoint {
  micro: Micro; // micro-USD per whole unit of the asset
  source: string; // 'peg' | 'sdex-1h' | 'manual' | ...
}

export interface PriceProvider {
  price(asset: string, atIso: string): Promise<PricePoint | null>;
}
