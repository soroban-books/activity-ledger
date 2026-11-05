# activity-ledger

[![CI](https://github.com/soroban-books/activity-ledger/actions/workflows/ci.yml/badge.svg)](https://github.com/soroban-books/activity-ledger/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)

Turn a Stellar address into books. It reads everything an address did (classic payments and Soroban contract activity), decodes it per protocol, prices it in USD at the time, tracks tax lots, lending positions and debt, recognises interest and rewards, and exports for tax tools and accountants.

> **Not tax advice.** Accounting treatments here are conventional defaults for a space with little official guidance. Every one is explicit, configurable where noted, and written down in [`docs/ACCOUNTING-POLICY.md`](docs/ACCOUNTING-POLICY.md) so an accountant can disagree with it.

## Status

Early (`0.1.0`). The engine, CLI and a local web UI work and are tested against real mainnet transactions. **Demand is not validated** and the project is not production hardened: read [Limits](#limits) before relying on any number.

## Quick start

Needs Node 22.18 or newer (built and tested on 24) and [pnpm](https://pnpm.io).

```bash
git clone https://github.com/soroban-books/activity-ledger
cd activity-ledger
pnpm install
node src/cli.ts serve            # web UI at http://localhost:4173
```

In the UI: paste an address, sync, then browse events, gains, income, balances and warnings, and download Koinly CSV, journal or JSON.

Or use the CLI:

```bash
node src/cli.ts sync   G... --db ledger.sqlite --limit 20     # try a small sync first
node src/cli.ts report G... --db ledger.sqlite [--year 2026] [--method FIFO|LIFO|HIFO] [--lp disposal|carryover] [--prices manual.csv]
node src/cli.ts events G... --db ledger.sqlite
node src/cli.ts export G... --db ledger.sqlite --out out --format all
```

Several addresses can be passed together; transfers between them are treated as non-taxable. Syncing is resumable. Export columns are described in [`docs/EXPORTS.md`](docs/EXPORTS.md).

Development: `pnpm test` (offline, uses `fixtures/`), `pnpm typecheck`, `pnpm build`. See [CONTRIBUTING.md](CONTRIBUTING.md).

## What it understands

| Area | Coverage |
|---|---|
| Classic and SAC payments | Transfers, fees, multi-payment transactions |
| **Blend v2** | Supply, withdraw, borrow, repay, flash loan, emissions claim, backstop deposit/withdraw/queue/claim, auctions and liquidations (valued from implied pool rates). Pools are verified through the Blend pool factory, not trusted by event shape. Details and what is verified on mainnet: [`docs/DECODERS.md`](docs/DECODERS.md) |
| **Soroswap** | Router swaps (exact), plus a generic heuristic for swaps, liquidity and vault shares from transfers |
| Interest | Realised lending, backstop and borrow interest derived from share ledgers (b-tokens, d-tokens), no state reads needed |
| Pricing | Manual CSV, USDC peg, SDEX hourly aggregates. Unpriced legs are flagged, never guessed |
| Lots | FIFO, LIFO, HIFO with holding periods |
| Exports | Koinly CSV, events, gains, income, double-entry journal, JSON |

## How it works

```
Horizon (which txs touch the address)
      + Galexie public data lake (full contract events per ledger)
      -> classify (verified protocol decoders, then a generic flow heuristic)
      -> price (manual, peg, SDEX)
      -> lots, lending positions, debt shares -> income, expenses, gains, warnings
      -> Koinly / journal / JSON / web UI
```

Raw transactions are stored in a local SQLite file, so reclassifying or changing policy never refetches. Design: [`docs/SPEC.md`](docs/SPEC.md). Verified facts and the mistakes found along the way: [`docs/VERIFIED-FINDINGS.md`](docs/VERIFIED-FINDINGS.md).

## Privacy and security

- It runs on your machine. The web server listens on loopback only, rejects foreign `Host` headers, and requires JSON on writes. Data lives in a local SQLite file.
- Public chain data only. There are no keys, no signing and no transaction sending anywhere.
- Fetching data does reveal the addresses you query to the services it calls: Stellar Horizon, the public AWS data lake, public Soroban RPC endpoints, and Horizon for SDEX prices.
- Chain-derived text in the UI is rendered as text, never HTML.

Report vulnerabilities as described in [SECURITY.md](SECURITY.md).

## Limits

- **Sync is network-bound.** Plan on seconds per ledger on a slow link, not CPU ([`docs/VERIFIED-FINDINGS.md`](docs/VERIFIED-FINDINGS.md) F-14). Cached ledgers are free the second time.
- **History window.** Discovery uses Horizon, whose earliest ledger moves forward about a day per day. Sync early and keep your database.
- **Decoders.** Blend v2 and the Soroswap router only. Aquarius, Phoenix, FxDAO and DeFindex are not decoded yet. Some Blend paths (borrow, flash loan, backstop) are built from the contract source and tested with synthetic events because no recent mainnet activity existed to capture; `docs/DECODERS.md` marks each one.
- **Interest** is recognised when realised (on withdrawal or repayment). Accrued but unwithdrawn interest is not.
- **Pricing** is SDEX-only plus the USDC peg. Soroban-AMM-only and illiquid assets are unpriced.
- The Koinly label mapping has not been checked against a live import.
- Non-SAC SEP-41 tokens default to 7 decimals.

## Documentation

[`docs/PRD.md`](docs/PRD.md) product and demand risk · [`docs/SPEC.md`](docs/SPEC.md) design · [`docs/DECODERS.md`](docs/DECODERS.md) protocol decoders · [`docs/ACCOUNTING-POLICY.md`](docs/ACCOUNTING-POLICY.md) treatments · [`docs/EXPORTS.md`](docs/EXPORTS.md) · [`docs/BUILD-PLAN.md`](docs/BUILD-PLAN.md) roadmap · [`docs/VALIDATION.md`](docs/VALIDATION.md) · [`docs/VERIFIED-FINDINGS.md`](docs/VERIFIED-FINDINGS.md)

Some market claims in `docs/PRD.md` and `docs/VALIDATION.md` cite private research notes that are not part of this repository. Treat those claims as unverified.

## Contributing

Contributions are welcome, especially protocol decoders backed by real mainnet fixtures. Start with [CONTRIBUTING.md](CONTRIBUTING.md). Everyone taking part is expected to follow the [Code of Conduct](CODE_OF_CONDUCT.md). Changes are tracked in [CHANGELOG.md](CHANGELOG.md).

## License

[MIT](LICENSE). The web UI bundles [Primer CSS](https://github.com/primer/css) (MIT, copyright GitHub Inc.); its licence is in `web/vendor/PRIMER-LICENSE`.
