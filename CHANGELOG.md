# Changelog

All notable changes are recorded here. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the project uses [Semantic Versioning](https://semver.org/) (while `0.x`, any minor release may change behaviour).

## [Unreleased]

### Added
- Local web UI (`activity-ledger serve`): sync with live progress, reports with year, cost-basis and liquidity filters, events, gains, income, balances, borrows and warnings tabs, and downloads for Koinly, events, gains, income, journal and JSON. Loopback only, with host, content-type and CSP checks.
- Blend v2 decoder covering the contract event set: pool supply, withdraw, borrow, repay, flash loan and claim; backstop deposit, withdraw, queue, dequeue and claim; auctions, liquidations and bad debt.
- Blend pool verification through the pool factory's storage, cached in SQLite. Contracts that only look like Blend are no longer decoded as Blend.
- Per-pool, per-asset d-token share ledger for borrow interest.
- Liquidation valuation from exchange rates derived from pool events (`src/blend/rates.ts`), for both the liquidated user and the liquidator.
- Soroban RPC client with endpoint fallback; resilient HTTP client with keep-alive, gzip, long timeouts and retries.
- Profiling, benchmark and mainnet probe scripts under `scripts/`.
- Static landing page in `site/` (no build step, real screenshots, light and dark) with a GitHub Pages workflow, and `scripts/capture-site-images.mjs` to regenerate the screenshots.
- MIT license, contributing guide, code of conduct, security policy, issue and pull request templates, CI workflow.

### Changed
- Sync is faster and sturdier: adaptive Horizon paging with prefetch, in-order streaming of results as ledgers arrive, warm lazily started decode workers, atomic cache writes. Measured on a slow link, 24 transactions went from 59 s to 41 s; the remaining time is download bandwidth.
- `Horizon` retry loop now retries network errors. One transient failure used to abort a whole sync.
- Documentation corrected: ledger decode is not the bottleneck (F-14) and Horizon's history window slides forward daily.

### Fixed
- A Blend supply or repay for an account's position paid by another address was booked as a wallet movement. A cash leg now needs a matching transfer that touches the account.
- Borrow interest was computed principal-first on a per-asset total, which mixed pools and mis-timed partial repayments.
- `invokedFunctions` decoded to NUL bytes instead of the function name.

## [0.1.0] - not yet released

Initial engine and CLI: Horizon discovery, Galexie lake reader, classification of classic payments, Soroswap router swaps and Blend v2 core events, FIFO/LIFO/HIFO lots, lending positions with realised interest, SDEX/peg/manual pricing, Koinly, events, gains, income, journal and JSON exports, SQLite store.
