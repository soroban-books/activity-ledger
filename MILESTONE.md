# Milestones

Where the project stands and where it is going. Detailed estimates and acceptance criteria live in [`docs/BUILD-PLAN.md`](docs/BUILD-PLAN.md); verified facts and past mistakes in [`docs/VERIFIED-FINDINGS.md`](docs/VERIFIED-FINDINGS.md). Last updated 2026-11-05, version `0.1.0`.

## Where we are

The engine, CLI and local web UI work and are tested against real mainnet transactions (57 offline tests). The project is early: it has not been through the correctness audit in M4, and demand is not validated (see G1). Check every number against the explorer before relying on it.

## Done

| Milestone | What shipped |
|---|---|
| **M0** Feasibility | Spikes comparing Horizon, the Galexie lake and Soroban RPC; event shapes; pricing (`docs/VERIFIED-FINDINGS.md`) |
| **M1** Ingestion | Horizon discovery, lake reader, worker-thread decode, SQLite store, resumable sync |
| **M2** Classification and engine | Flows, Blend, Soroswap router, generic heuristic, fees; tax lots, positions, income, expenses, warnings |
| **M2b** Exports and CLI | Koinly CSV, events, gains, income, journal, JSON; report |
| **UI** Local web app | `serve` with live sync progress, reports, filters, tabs, downloads; loopback-only with host, content-type and CSP checks |
| **M3 (Blend)** Blend v2 in depth | Pool verification through the factory, borrow and repay by d-token shares, flash loans, backstop, auctions and liquidations, bad debt; liquidations valued from rates implied by pool events |
| **M7 (part)** Sync speed and reliability | Resilient HTTP, adaptive paging with prefetch, in-order streaming, warm workers, RPC endpoint fallback |
| **Open source** | MIT license, contributing guide, code of conduct, security policy, templates, CI, a landing page |
| **Release 0.1.0** | Published to npm: `npx activity-ledger serve` runs from a clean machine (2026-11-05) |

## Known gaps

What does not work yet, so nobody has to find out the hard way.

**Coverage**
- Only Blend v2 and the Soroswap router are decoded. Aquarius, Phoenix, FxDAO and DeFindex are not.
- Blend v1 pools verify through their own factory but are decoded with v2 event shapes, which were not checked.
- `bad_debt` write-offs and Blend bad-debt and interest auction fills are recorded as notices or unvalued, not booked.

**Verification**
- Blend borrow, flash loan, backstop and emissions claim are built from the contract source and tested with synthetic events, because no recent mainnet activity existed to capture. Liquidation and the core supply and withdraw paths are verified on real transactions. `docs/DECODERS.md` marks each path.
- The Koinly label mapping has not been checked against a live import.
- No hand-audited corpus of real addresses yet (M4).

**Accounting**
- Interest is recognised when realised (withdrawal or repayment). Accrued but unwithdrawn interest is not (M5).
- Pricing is the SDEX plus the USDC peg. Soroban-AMM-only and illiquid assets are unpriced and flagged, for example the comet LP token of the Blend backstop.
- Non-SAC SEP-41 tokens default to 7 decimals.
- A liquidator's discount is realised only when it later sells the collateral. Treating liquidation as "collateral sold for the debt relieved" is a conventional, contested reading (`docs/ACCOUNTING-POLICY.md`).
- Activity older than the sync window cannot be fully classified; the engine flags it rather than guessing.

**Data and speed**
- History is limited to Horizon's rolling window, whose start moves forward about a day per day. Sync early and keep the database.
- Sync is network-bound: seconds per ledger on a slow link, free for already-cached ledgers. A transaction whose ledger download fails permanently is recorded as skipped but not retried automatically.

**Product**
- Demand is not validated: the 10 interviews in `docs/VALIDATION.md` (Gate G1) have not started, and the PRD asks for them before any hosted work.
- No hosted service or HTTP API for third parties; it runs locally only.

## Next

Roughly in priority order. "Done when" is the acceptance bar.

| Milestone | Scope | Done when |
|---|---|---|
| **G1** Demand gate | 10 interviews with Soroban DeFi users, treasuries, accountants and tax-vendor staff | At least 3 would pay, or at least 2 vendors would trial a feed; otherwise keep the engine as open-source infrastructure |
| **M3** More decoders | Aquarius, Phoenix, DeFindex vaults, FxDAO | Each has a mainnet fixture, exact-amount tests, a conservation check and zero new `unclassified` on the fixture |
| **M4** Correctness corpus | 20 or more real addresses, hand-audit 50 events, opening-balance import, a real Koinly import | At least 95% of events exact or heuristic; every `no_lots` or `unknown_basis` explained; Koinly labels confirmed |
| **M5** Accrual and prices | Accrued Blend interest (current rate by RPC read, historical by implied rates), Reflector and AMM pool prices, monthly income report | Accrued interest equals `shares x (b_rate_end - b_rate_start)` within 1 unit at 5 sampled positions |
| **M6** Service | HTTP API with keys, queue, Postgres, hosted sync, read-only web report | `GET /events` p95 under 500 ms for a stored account; sync idempotent and resumable |
| **M7** Sync speed | Soroban RPC fast path for the last 7 days (about 50x fewer bytes), shared lake cache, automatic retry of skipped transactions | Measured sync time drops on a cold cache |
| **M8** Vendor path | Feed or SDK for tax vendors, QuickBooks and Xero files, a wallet-backend `ProtocolProcessor` contribution | One vendor integration letter of intent |
| **M9** RWA / DTCC | Registered-wallet assets, NAV accrual, distributions | On hold until DTCC publishes its spec |

Want to help? Protocol decoders backed by real mainnet fixtures are the most useful contribution. See [CONTRIBUTING.md](CONTRIBUTING.md).
