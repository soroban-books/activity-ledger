# Build plan

Estimates are **[judgment]** for one developer. "Done" means built, tested and run against mainnet data unless stated.

## Repository map
```
activity-ledger/
  docs/            PRD, SPEC, DECODERS, ACCOUNTING-POLICY, EXPORTS, BUILD-PLAN, VALIDATION, VERIFIED-FINDINGS
  src/
    types.ts util.ts assets.ts store.ts sync.ts pipeline.ts report.ts cli.ts
    sources/       horizon.ts  lake.ts  lake-worker.ts
    classify/      index.ts ctx.ts flows.ts blend.ts soroswap.ts generic.ts
    ledger/        money.ts lots.ts positions.ts engine.ts
    pricing/       types.ts providers.ts
    export/        csv.ts koinly.ts reports.ts
  test/            classify.test.ts ledger.test.ts export.test.ts helpers.ts
  fixtures/        real mainnet transactions (blend-roundtrip, soroswap-swap, classic-multipay)
  scripts/         spikes, fixture capture, profiling (see VERIFIED-FINDINGS.md)
  out/example/     a real export from 100 mainnet transactions
```
Run: `pnpm install` · `pnpm test` (offline, ~35 s) · `pnpm typecheck` · `node src/cli.ts sync|report|events|export <G...>`.

## Milestones

| # | Milestone | Scope | Est. | Status |
|---|---|---|---|---|
| **M0** | Feasibility spikes | Horizon vs lake vs RPC; event shapes; pricing; performance | 2 d | **Done** (`VERIFIED-FINDINGS.md`) |
| **M1** | Ingestion | Horizon discovery, lake reader, worker decode, SQLite store, resume | 3 d | **Done** |
| **M2** | Classification + engine | Flows, Blend, Soroswap router, generic, fees; lots, positions, income/expense, warnings; 23 tests on real fixtures | 5 d | **Done** |
| **M2b** | Exports + CLI | Koinly, events, gains, income, journal, JSON; report | 2 d | **Done** (Koinly labels unverified) |
| **G1** | **Demand gate** | 10 interviews (`VALIDATION.md`); decision to continue | 2 wk elapsed, ~3 d effort | **Not started — do this before M3+** |
| **M3** | Decoder coverage | Blend done in depth (pool verification, borrow/repay shares, flash loan, backstop, liquidations; see DECODERS.md for what is mainnet-verified). Still to do: Aquarius, Phoenix, DeFindex vaults, FxDAO; Blend liquidation valuation (needs M5 rates) | 2–3 wk | Blend done, others not started |
| **M4** | Correctness corpus | ≥ 20 real addresses, hand-audit 50 events, opening-balance import, fix Koinly labels via real import, extend F-9 test | 1 wk | Not started |
| **M5** | Accrual + prices | Blend b-rate state reads for accrued interest; Reflector and AMM pool prices; monthly income report | 2 wk | Not started |
| **M6** | Service | HTTP API (SPEC §9.1), queue + worker, Postgres, API keys, hosted sync, read-only web report | 3–4 wk | Not started |
| **M7** | Performance | ~~Rust decoder~~ (F-14: decode is not the bottleneck). Do instead: Soroban RPC fast path for the last 7 days (about 50x fewer bytes), shared/hosted lake cache, resumable skipped-tx retry | 2 wk | Partly done: resilient HTTP, adaptive paging, streamed in-order sync, warm workers |
| **M8** | Vendor/partner path | Feed/SDK for tax vendors; QuickBooks/Xero files; wallet-backend `ProtocolProcessor` contribution | 2 wk | Not started |
| **M9** | DTCC/RWA extension | Registered-wallet assets, NAV accrual, distributions | scope after DTCC publishes its spec | Watch (re-screen triggers in `../zero-to-one-discovery/notes/tokenized_stocks_screen.md`) |

## Acceptance criteria (per milestone)
- **M3:** every new decoder has a mainnet fixture, exact-amount assertions, a conservation or reconciliation check, and zero new `unclassified` on the fixture; Allium differential for Blend within 1 unit.
- **M4:** ≥ 95% events `exact`/`heuristic`; every `no_lots`/`unknown_basis` warning explained by pre-window history; a real Koinly import succeeds and labels match intent.
- **M5:** accrued interest for a Blend position matches `shares × (b_rate_end − b_rate_start)` within 1 unit at 5 sampled positions.
- **M6:** `GET /events` p95 < 500 ms for a stored account; sync is idempotent and resumable; no private key material anywhere.
- **M7:** 100× throughput on a 1,000-ledger backfill; identical output to the JS decoder on 50 sampled ledgers.

## Dependencies and risks
| Risk | Mitigation |
|---|---|
| Demand does not exist (PRD §9) | Gate G1; kill criteria; pivots listed in PRD §9 |
| Allium or a tax vendor ships Stellar DeFi | Position as feed/decoder library; contribute to wallet-backend |
| Lake format or Horizon fields change | Version the lake path; fixtures + decode tests catch it; Horizon is discovery only |
| Protocol upgrades break decoders | Shape-based recognition, never throw, fixtures per protocol version, `unclassified` warnings surface drift |
| Pre-window history | Opening-balance import (M4); alternative discovery source (M7) |
| Accounting disputes | Policy is explicit and configurable; every row traces to a transaction |

## Next three actions
1. Run the interviews (`VALIDATION.md`). 2. Do one real Koinly import and correct `LABELS`. 3. Extend the F-9 indirect-participation test to vault payouts.
