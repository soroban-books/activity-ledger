/** Normalised shapes shared by sources, decoders, the ledger and exporters. */

/** A CAP-67 / contract event with ScVals already converted to plain JS. */
export interface RawEvent {
  ledger: number;
  txHash: string;
  opIndex: number | null; // null = transaction-level (e.g. fee events)
  eventIndex: number;
  contractId: string | null; // C... strkey
  type: 'contract' | 'system' | 'diagnostic';
  topics: unknown[];
  data: unknown;
}

export interface RawTx {
  ledger: number;
  closedAt: string; // ISO-8601 UTC
  hash: string;
  applicationOrder: number;
  sourceAccount: string;
  feeAccount: string;
  successful: boolean;
  feeCharged: bigint;
  /** Operation type names in envelope order, e.g. 'invokeHostFunction'. */
  opTypes: string[];
  /** Contract ids invoked at the top level by invokeHostFunction ops. */
  invokedContracts: string[];
  /** Function names invoked at the top level, parallel to invokedContracts. */
  invokedFunctions: string[];
  events: RawEvent[];
}

export type EventKind =
  | 'transfer_in'
  | 'transfer_out'
  | 'trade'
  | 'lp_add'
  | 'lp_remove'
  | 'lend_supply'
  | 'lend_withdraw'
  | 'borrow'
  | 'repay'
  | 'reward_claim'
  | 'interest_income'
  | 'fee'
  | 'mint'
  | 'burn'
  | 'liquidation'
  | 'vault_deposit'
  | 'vault_withdraw'
  | 'unclassified'
  /** A recognised protocol action that moved no value for the account (queue a withdrawal, auction notice). */
  | 'no_op';

/** One asset movement belonging to an accounting event. Amounts are in base units. */
export interface Leg {
  direction: 'in' | 'out';
  asset: string; // 'native', 'CODE:ISSUER', or contract id C...
  amount: bigint; // base units
  decimals: number;
}

/**
 * A change in a share-based position. `protocol` selects the ledger: 'blend' (supplied or
 * collateral b-tokens), 'blend-debt' (borrowed d-tokens), 'blend-backstop' (backstop shares).
 * `tokens` is the underlying amount when the event states it.
 */
export interface PositionChange {
  protocol: string;
  pool: string;
  asset: string;
  shares: bigint;
  direction: 'in' | 'out';
  tokens?: bigint;
}

/** An accounting event: the unit that is classified, priced and exported. */
export interface LedgerEvent {
  id: string; // deterministic: `${txHash}:${seq}`
  txHash: string;
  ledger: number;
  closedAt: string;
  /** Position of the transaction inside its ledger (replay order). */
  txOrder: number;
  kind: EventKind;
  protocol: string | null; // 'blend' | 'soroswap' | 'generic' | null
  legs: Leg[];
  counterparty: string | null;
  note: string;
  /** Lending position bookkeeping for Blend-style share tokens (b-tokens, d-tokens, backstop shares). */
  position?: PositionChange;
  /** Several position changes at once (a liquidation moves collateral and debt of several reserves). */
  positions?: PositionChange[];
  /** How sure the classifier is: 'exact' (protocol decoder), 'heuristic', 'unknown'. */
  confidence: 'exact' | 'heuristic' | 'unknown';
}
