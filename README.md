# activity-ledger

Turn a Stellar address into books: decode Soroban DeFi activity, classify it, price it, track lots and lending positions, recognise interest and rewards, and export for tax tools and accountants.

**Status (2026-10-25):** the engine works and is tested against real mainnet transactions (23/23 offline tests). Demand is **not validated**. Read `docs/PRD.md` §9 before building more.

## What works today
- Discovers an address's transactions (Horizon) and reads their full event meta from the public Galexie lake.
- Classifies classic and Soroban activity: transfers, swaps (Soroswap exact + generic heuristic), liquidity and vault shares, Blend supply/withdraw/borrow/repay/claim, network fees.
- Tracks tax lots (FIFO/LIFO/HIFO) and Blend positions; derives **realised interest** from the share ledger without state reads.
- Prices from manual CSV, USDC peg, and SDEX hourly aggregates.
- Exports Koinly CSV, events, gains, income, double-entry journal and JSON. A real example from 100 mainnet transactions is in `out/example/`.

## What does not (be honest)
First sync is slow (JS XDR decode 4–8 s per ledger, `docs/VERIFIED-FINDINGS.md` F-6); history older than Horizon's rolling window is out of reach (the window start moves forward about a day per day: it was 2025-09-07 on 2026-10-24 and 2025-09-19 on 2026-11-04, so sync early and keep your database); only Blend v2 and the Soroswap router are decoded; accrued-but-unwithdrawn interest is not recognised; Koinly label mapping is unverified; accounting defaults are conventional, not tax advice.

## Web UI
```bash
pnpm install && node src/cli.ts serve        # http://localhost:4173
```
Paste an address, sync, then browse events, gains, income, balances and warnings, and download Koinly CSV, journal or JSON. It runs on your machine (loopback only), keeps data in a local SQLite file and reads public chain data only. Built version: `pnpm build && node dist/cli.js serve`.

## Quick start (CLI)
```bash
pnpm install                       # Node >= 22.18 (type stripping on by default; built and tested on 24)
pnpm test                          # offline, uses fixtures/
node src/cli.ts sync   G... --db ledger.sqlite --limit 100
node src/cli.ts report G... --db ledger.sqlite [--year 2026] [--method FIFO|LIFO|HIFO] [--lp disposal|carryover] [--prices manual.csv]
node src/cli.ts export G... --db ledger.sqlite --out out --format all
```
Several addresses can be passed together; transfers between them are treated as non-taxable.

## Docs
`docs/PRD.md` product · `docs/SPEC.md` design · `docs/DECODERS.md` · `docs/ACCOUNTING-POLICY.md` · `docs/EXPORTS.md` · `docs/BUILD-PLAN.md` · `docs/VALIDATION.md` · `docs/VERIFIED-FINDINGS.md`

## Provenance
Idea and market evidence: `../zero-to-one-discovery/notes/` (`soroban_ledger_prior_art.md`, `vendor_soroban_check.md`, `novelty_screen_B.md`).
