# Activity Ledger — Technical Specification

Version 0.1 · 2026-10-25. Everything marked **[built]** exists in `src/` and is covered by `test/`. Everything marked **[T2]/[T3]** is specified but not built. Facts about the network are numbered `F-n` and recorded with dates and commands in `VERIFIED-FINDINGS.md`.

---

## 1. Architecture

```
                 ┌────────────────────────── discovery ──────────────────────────┐
 G... address ──▶│ Horizon /accounts/{id}/transactions  (hashes, ledger, envelope) │
                 └───────────────┬───────────────────────────────────────────────┘
                                 │ (ledger, tx hash) pairs, batched 32
                                 ▼
                 ┌────────────── events (full CAP-67 meta) ──────────────┐
                 │ Galexie public lake: 1 zstd LedgerCloseMeta per ledger │──▶ decode in worker threads
                 │ (cached on disk)                                        │    keep only wanted tx hashes
                 └───────────────┬────────────────────────────────────────┘
                                 ▼ RawTx { events[] , envelope metadata }
                          SQLite store (raw txs, cursors, skipped)
                                 │  (reclassifying never refetches)
                                 ▼
        ┌─────────────── classify (per account, pure) ───────────────┐
        │ flows (CAP-67) → protocol decoders (exact) → generic       │
        │ heuristic → fee → unclassified                              │
        └───────────────┬────────────────────────────────────────────┘
                        ▼ LedgerEvent[]  (sorted: ledger, tx order, seq)
        ┌─────────────── engine (async, deterministic) ──────────────┐
        │ price legs → lots (FIFO/LIFO/HIFO) → lending positions →   │
        │ income / expenses / disposals / warnings                    │
        └───────────────┬────────────────────────────────────────────┘
                        ▼
          exports: koinly.csv · events.csv · gains.csv · income.csv · journal.csv · ledger.json
```

Design rules: (1) pure functions between stages so every stage is unit-testable on fixtures; (2) the raw transaction is the unit of storage, so decoders can improve and history is reclassified for free; (3) nothing is dropped silently — failures become `skipped` rows or `warnings`.

## 2. Data sources and what was verified

| Source | Used for | Verified facts |
|---|---|---|
| **Horizon** `/accounts/{id}/transactions?order=asc&include_failed=true` | Discovery of an account's transactions; envelope (source, ops, invoked contract/function) | F-1: Horizon v30 transaction records have **no `result_meta_xdr`** (fields: envelope_xdr, result_xdr, fee_meta_xdr). F-2: earliest ledger 58,812,481 (≈ 2025-09-07). |
| **Galexie public lake** `s3://aws-public-blockchain/v1.1/stellar/ledgers/pubnet/` | Full per-transaction meta incl. CAP-67 events | F-3: `.config.json` = `{ledgersPerBatch:1, batchesPerPartition:64000, compression:"zstd"}`. F-4: meta v4 carries op-level events and tx-level `{stage,event}` wrappers (fee events). F-5: classic payments emit CAP-67 `transfer` events (101 events for a 100-payment tx). |
| **Soroban RPC** | Not used by T1. Recent window only (F-7: `ledgerRetentionWindow` 120,960 ≈ 7 days). Spec'd as a fast path for the last 7 days in T2. | |
| **SDEX via Horizon `trade_aggregations`** | USD prices (hourly close) | F-8: XLM/USDC and BLND/USDC aggregates available; BLND price matched the implied price of a real swap within 1%. |

The lake layout is `…/<partition>/<name>.xdr.zst` where `hex8(n) = (0xFFFFFFFF − n)` upper-case zero-padded to 8, `partition = hex8(start)--start-end` with `start = floor(ledger/64000)*64000`, file = `hex8(ledger)--ledger.xdr.zst`. Implemented in `src/sources/lake.ts` (`lakeUrl`).

### 2.1 Why not the alternatives

- **Horizon effects/operations:** no contract events, no Soroban DeFi semantics.
- **Soroban RPC `getEvents`:** 7-day window only (F-7), so useless for tax years.
- **Hubble/BigQuery:** needs a GCP project and credentials; kept as T2 alternative for bulk backfill.
- **Lake Parquet (`v1.1/stellar/parquet/pubnet/v1/date=…/<ledger>.parquet`):** per-ledger files with nested `transactions → operations → events` (F-10). Reading one with a pure-JS reader took ~4 s (ZSTD needs an injected codec), no better than XDR decode, so not adopted. A native reader (DuckDB, arrow-rs) could change this in T3.

## 3. Canonical data model

All types are in `src/types.ts`.

**RawEvent** — a CAP-67/contract event with ScVals converted to JS: `{ledger, txHash, opIndex|null, eventIndex, contractId, type, topics[], data}`. `opIndex = null` for transaction-level events (fees).

**RawTx** — `{ledger, closedAt, hash, applicationOrder, sourceAccount, feeAccount, successful, feeCharged, opTypes[], invokedContracts[], invokedFunctions[], events[]}`.

**Leg** — one asset movement: `{direction: in|out, asset, amount (base units, bigint), decimals}`. Asset key: `'native'`, `'CODE:ISSUER'` for SACs, or a contract id `C…` for other tokens.

**LedgerEvent** — the unit that is classified, priced and exported: `{id, txHash, ledger, closedAt, txOrder, kind, protocol, legs[], counterparty, note, position?, confidence}`.
- `kind` ∈ transfer_in, transfer_out, trade, lp_add, lp_remove, vault_deposit, vault_withdraw, lend_supply, lend_withdraw, borrow, repay, reward_claim, interest_income*, fee, mint, burn, liquidation*, unclassified. (*reserved, not emitted by T1 decoders.)
- `confidence` ∈ `exact` (protocol decoder or direct CAP-67 transfer), `heuristic` (generic flow inference), `unknown`.
- `position` = `{protocol, pool, asset, shares, direction}` for lending share bookkeeping.

**Money** (`src/ledger/money.ts`) — base units are `bigint`; USD is integer **micro-USD** (1e-6). `valueMicro(units, decimals, priceMicro)` rounds half away from zero; `prorate` is exact integer arithmetic. No `number` ever holds a balance, basis or gain.

**Storage** (`src/store.ts`, `node:sqlite`): `txs(account, hash, ledger, ord, closed_at, json)`, `cursors(account, paging_token)`, `skipped(account, hash, ledger, reason)`, `registry` (reserved). Raw transactions serialise bigints as `{"$big":"…"}` (`stringifyFixture`/`parseFixture`).

## 4. Ingestion [built]

`syncAccount(account, opts)` (`src/sync.ts`):
1. Page Horizon (`limit=200`, ascending, from stored cursor), parse each envelope with `TransactionBuilder.fromXDR` for op types and invoked contract/function (best effort).
2. Collect batches of 32 transactions; group by ledger; download each distinct ledger from the lake with concurrency 8 (retry with exponential backoff, on-disk cache `.cache/lake/<ledger>.xdr.zst`).
3. zstd-decompress, then decode the XDR **in a worker-thread pool** (size = cores−1, max 8) because decode is CPU-bound (F-6: 4–8 s per ledger). Workers return only the wanted transaction hashes to keep IPC small.
4. Join Horizon and lake records by `(ledger, hash)`; invoke `onTx` in order. A missing ledger or transaction becomes a `skipped` row with the reason.

Failure modes handled: HTTP 404 (ledger not in lake yet), transient errors (retry), Horizon 429/5xx (retry), failed transactions (kept, fee only).

## 5. Classification [built]

Entry point `classifyTx(tx, account, registry)` (`src/classify/index.ts`). Order matters:

1. **Learn assets.** `AssetRegistry.learn(events)` maps SAC contract id → classic asset from the 4th topic of CAP-67 events; seeded with XLM, USDC, BLND SACs (`src/assets.ts`).
2. **Flows.** `extractFlows` turns `transfer|mint|burn|clawback` events into `Flow{kind, asset, from, to, amount, muxedId}`. Data may be a bare i128 or `{amount, to_muxed_id}` (F-5). Zero-amount flows are dropped. Failed transactions yield no flows.
3. **Protocol decoders** (`decodeBlend`, `decodeSoroswap`) emit exact events and **claim** the flows they explain (`claimFlow`), so the same movement is never counted twice.
4. **Generic heuristic** (`classifyGeneric`) over unclaimed flows touching the account:
   - minted share in + ≥1 asset out → `lp_add` (≥2 out assets) or `vault_deposit` (1 out asset)
   - burned share out + ≥1 asset in → `lp_remove` (≥2 in) or `vault_withdraw` (1 in)
   - net per asset (so a payment plus its refund is not a trade): different assets out and in → `trade`
   - otherwise one `transfer_in`/`transfer_out` per movement (counterparty and memo id preserved)
5. **Fee.** `netFee` sums `fee` events for the account (charge minus refund). Emits `fee` as `exact`.
6. **Unclassified.** A successful contract call by the source/fee-paying account with no asset movement → `unclassified` (bystanders never get this).

The generic path cannot distinguish supply from sale, repay from payment, or compute interest; that is what protocol decoders are for (`DECODERS.md`).

## 6. Accounting engine [built]

`Engine.apply(event)` (`src/ledger/engine.ts`) processes events in order `ledger → txOrder → sequence` (`byChronology`). Every leg is priced first (`priceLegs`); an unpriced leg adds an `unpriced` warning and a value of null.

### 6.1 Lots (`src/ledger/lots.ts`)
Per-asset lot book; `acquire`, `dispose` (realises gain), `carryOut` (moves basis without gain). Methods FIFO, LIFO, HIFO. Proceeds are fully allocated across consumed lots (the last piece takes the remainder, so allocations sum exactly). A disposal larger than tracked lots reports `shortfall`; the engine records the shortfall as a zero-basis disposal **and** a `no_lots` warning.

### 6.2 Event treatment
Defaults and alternatives are in `ACCOUNTING-POLICY.md`. Summary of `apply`:

| Kind | Effect |
|---|---|
| transfer_in / mint | acquire at fair value (internal transfers between owned addresses ignored) |
| transfer_out / burn | dispose at fair value (internal ignored) |
| fee | dispose native at fair value + record `network_fee` expense |
| trade | proceeds = Σ in-legs value (else Σ out); dispose outs, acquire ins at allocated value |
| lp_add / vault_deposit | policy `disposal`: dispose outs, acquire share at proceeds. `carryover`: move basis into share lot |
| lp_remove / vault_withdraw | mirror image |
| lend_supply | policy `carryover`: move lots into the position (keeps basis and acquisition date); `disposal`: dispose at fair value |
| lend_withdraw | release principal from position back to wallet lots with original basis/dates; interest → income + new lot at fair value |
| borrow | acquire at fair value, record debt |
| repay | dispose repaid units; repayment beyond tracked debt → `borrow_interest` expense |
| reward_claim | income + acquire at fair value |

### 6.3 Interest without state reads (key design point)
Blend emits `supply`/`withdraw` with `[tokens, b_tokens]` but **no interest event** (confirmed from source, `DECODERS.md`). The share price is recoverable from every event: `rate = tokens / b_tokens` (e.g. 166,900,000 / 144,638,091 = 1.15392 on supply and 60,000,000 / 51,988,912 = 1.15409 on withdraw, mainnet, 2026-10-19). `Positions` (`src/ledger/positions.ts`) keeps `{shares, principalUnits, carries[]}` per `(protocol, pool, asset)`:

- deposit: `shares += minted`, `principalUnits += tokens`, carry the consumed lots.
- withdraw burning `b` of `S` shares for `T` tokens: principal released = `principalUnits × b / S`; **interest = T − principal released**; released carries return to the wallet with original basis/dates.
- shares never seen deposited (history before the sync window) cannot have a known principal: their tokens are returned as **`unknown_basis`** with a warning, never counted as interest.

Conservation invariant (tested): `supplied = withdrawn − interest + principal still in pool`.

Realised interest only. Interest accrued but not yet withdrawn requires reading the pool's reserve state at period boundaries (T2, FR-29).

### 6.4 Multi-address
`ownAddresses` = all synced addresses. A transfer whose counterparty is owned changes no lots (the combined book is shared), so moving funds between your own wallets is never a disposal.

## 7. Pricing [built]

`PriceProvider.price(asset, atIso) → {micro, source} | null`. Composite order: **Manual CSV** (`asset,iso_prefix,usd_price`, longest prefix wins) → **Peg** (explicit allow-list; only USDC today; depegs not modelled) → **SDEX** (hourly `trade_aggregations` close, looks back ≤24 h; asset→USDC, else asset→XLM→USDC). Unpriced assets are never guessed. T2: Reflector oracle, Soroswap/Aquarius pool prices for AMM-only assets.

## 8. Exports [built]

See `EXPORTS.md`. All exporters are pure functions of `(events, EngineResult)`.

## 9. T2 specification (not built)

### 9.1 HTTP API
Read-only JSON; auth by API key; all amounts as decimal strings in base units plus `decimals`.

```
POST /v1/accounts/{G...}/sync            -> 202 {jobId}          # starts/resumes sync
GET  /v1/accounts/{G...}/status          -> {syncedThroughLedger, txCount, skipped, warnings}
GET  /v1/accounts/{G...}/events?from&to&kind&protocol&limit&cursor
GET  /v1/accounts/{G...}/report?year&method&lp&format=json|koinly|journal|gains|income
GET  /v1/accounts/{G...}/positions       -> open lending positions with principal, shares
GET  /v1/transactions/{hash}/events?account=G...   # explain one transaction
```
`events` item: `{id, tx, ledger, time, kind, protocol, confidence, legs[{direction, asset, amount, decimals, usd}], counterparty, note}`. Errors: RFC 9457 problem details. Idempotent sync; rate limits per key.

### 9.2 Worker and storage
Queue (one job per account), the T1 pipeline as the worker, Postgres replacing SQLite, lake cache on object storage. Re-classification jobs run when decoders ship.

### 9.3 Accrual reports
Snapshot each open Blend position at period ends by reading the pool's `get_reserve` state (`b_rate`) via RPC `getLedgerEntries` at the target ledger or from archive; income accrued = `shares × Δ b_rate`.

### 9.4 Performance (T3)
Replace the JS decode with a native decoder (Rust `stellar-xdr`, streaming, skips ledger-entry changes): target <50 ms per ledger vs 4–8 s today.

## 10. Security and privacy

Public data only. No private keys are ever read or requested. Local SQLite; hosted mode (T2) stores only public addresses and derived ledgers. Inputs validated with `StrKey.isValidEd25519PublicKey`. Output files are written under a user-specified directory. No telemetry.

## 11. Testing strategy [built]

- **Fixtures from mainnet** (`fixtures/*.json`, captured by `scripts/capture-fixture.ts`): a Blend supply/withdraw round trip, a Soroswap router swap, a 100-payment classic transaction. Tests assert exact amounts from real events.
- Unit tests: money rounding, lots (all three methods, shortfall), positions (proportional release, unknown basis), chronology, CSV escaping.
- Property checks implemented as invariants: Blend principal conservation, journal debits = credits, no blank journal amounts, no events for bystanders.
- `scripts/e2e-classify.ts` and the CLI run the full path against live mainnet.
- To add: golden-file regression for each new protocol decoder (required by `DECODERS.md`), a differential test against Allium tables for Blend (T2), and a corpus of ≥20 real addresses (PRD §12).

## 12. Limitations (authoritative list)

See PRD §11. In short: Horizon's history window; indirect-participation only narrowly tested (F-9: 5/5 listed); slow first sync; SDEX/peg-only pricing; Blend v2 + Soroswap router only; realised interest only; conventional accounting defaults; unverified Koinly labels; default 7 decimals for unknown SEP-41 tokens.
