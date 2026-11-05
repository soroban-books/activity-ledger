# Activity Ledger — Product Requirements

**Status:** MVP engine built and tested (see `BUILD-PLAN.md`). Demand is **not yet validated** (see §9 and `VALIDATION.md`).
**Working name:** `activity-ledger` (rename freely).
**Last updated:** 2026-10-25.
**Provenance:** this PRD comes out of a private Stellar discovery exercise. Market claims below cite notes from it (`notes/...`) that are **not part of this repository**, so outside readers cannot check them: treat every market and competitor claim as **[unverified]** until independently confirmed. Anything that is judgment is labelled **[judgment]**. Technical claims are different: those are checked in `VERIFIED-FINDINGS.md` with scripts you can run.

---

## 1. One-paragraph summary

Turn a Stellar address into books. Read everything an address did (classic payments and Soroban contract activity), decode it per protocol (Blend lending, Soroswap swaps, generic liquidity and vault shares, rewards, fees), classify each movement into an accounting event, price it in USD at the time, track tax lots and lending positions, recognise income (lending interest, rewards), and export it as CSV for tax tools (Koinly), as a double-entry journal for accountants, or as JSON for other software. The gap it fills: no tax or accounting vendor shown to support Soroban DeFi, and no open per-address, accounting-grade ledger exists.

## 2. Problem

A person or organisation that used Soroban DeFi — supplied to a Blend pool, swapped on Soroswap, added liquidity, claimed BLND rewards — cannot get a correct statement of what happened for tax or bookkeeping:

- **Tax and accounting vendors cover classic Stellar only.** 0 of 19 vendors checked advertise Soroban support; 9 were readable and describe classic coverage with a roughly one-year history cap; 10 stayed unverified or inconclusive (`notes/vendor_soroban_check.md`).
- **The decoded data exists but is sold as a warehouse.** Allium publishes Stellar tables (Blend lending events, DEX trades with Soroswap named, RWA transfers, prices with `usd_amount` at event time). It is enterprise data, not a per-address ledger, and its wallet/PnL APIs list EVM, Solana and Bitcoin only (`notes/soroban_ledger_prior_art.md`, section A).
- **Portfolio trackers show current positions, not books.** Smoothie, Dig and OctoPos show where you stand now. None was found with event-sourced history, cost basis or export.
- **The two attempts at this died.** LedgersTax (SCF #35): domain parked for sale, last commit 2025-04-13. KwickBit (SCF #24): built Soroswap-only decoding, then wrote that "business potential for a crypto accounting tool targeting small and medium businesses is low" and pivoted to a payment gateway. **This is the strongest evidence against the product and is addressed in §9.**
- **Interest is invisible in the event stream.** Blend emits principal flows but no interest event. Whoever wants "how much did I earn" must derive it. (Solved here without state reads, see `SPEC.md` §6.3.)

## 3. Users and jobs to be done

| Persona | Situation | Job |
|---|---|---|
| **DeFi user / trader** | Used Blend, Soroswap, a vault; tax season | "Give me a CSV my tax software accepts, with the DeFi income counted." |
| **DAO / treasury operator** | Treasury supplies stablecoins, swaps, receives rewards; needs monthly books | "Give my accountant a journal of income, fees and gains." |
| **Accountant / bookkeeper** | Client holds Soroban positions | "Tell me what each on-chain action was and its USD value, with an audit trail to the transaction." |
| **Tax-tool or wallet vendor** (distribution partner) | Wants Stellar DeFi support without building decoders | "Call an API / import a feed that returns classified events." |
| **RWA holder / issuer ops** *(later)* | Holds yield-bearing RWA tokens | "Recognise NAV accrual and distributions as income." |

Primary persona for MVP: **DeFi user and DAO treasury** [judgment — to be confirmed by interviews].

## 4. Goals and non-goals

**Goals**
1. A correct, explainable ledger for an address: every classified event traces to a transaction hash and the exact CAP-67/contract events that produced it.
2. Honest uncertainty: each event carries `confidence` (exact / heuristic / unknown); every limitation surfaces as a **warning**, never silently ignored.
3. Interest and reward income recognised with an explicit, configurable policy.
4. Output that existing tools consume (Koinly CSV) so incumbents are distribution, not competition.
5. Cheap to extend: adding a protocol decoder is a small, test-first change.

**Non-goals (MVP)**
- Not tax advice, not a filing tool; no jurisdiction-specific forms.
- Not a portfolio dashboard or position manager.
- Not a custody, signing or transaction-sending product.
- Not a real-time alerting system.
- No fiat price oracle product; price sources are pluggable, SDEX-based by default.

## 5. Scope tiers

| Tier | Contents | Status |
|---|---|---|
| **T1 (MVP)** | Library + CLI. Classic and SAC transfers, generic swap/LP/vault heuristic, Blend (supply, withdraw, borrow, repay, claim), Soroswap router swaps, network fees, lots (FIFO/LIFO/HIFO), lending positions with realised interest, SDEX/peg/manual pricing, Koinly + events + gains + income + journal + JSON export, SQLite store, offline tests on real fixtures | **Built, 23/23 tests pass** |
| **T2** | HTTP API + hosted worker; more decoders (Aquarius, Phoenix, FxDAO, DeFindex vaults, Blend auctions/backstop); Reflector/other price sources; unrealised-income snapshots (b-rate state reads); QuickBooks/Xero export; multi-account groups; web report (read-only) | Specified (`SPEC.md` §9), not built |
| **T3** | Rust ingestion binary (100x faster decode); history older than Horizon's window; RWA NAV accrual and DTCC-era assets; partner SDK for tax vendors; audit-log/immutability features | Specified, not built |

## 6. Functional requirements

IDs are stable; status is the current build state.

### Ingestion
- **FR-1** Given a `G...` address, discover every transaction that involves it (Horizon account transactions, includes failed). *Built.*
- **FR-2** For each transaction obtain the full CAP-67 / contract event set, including classic payments (Galexie public lake). *Built.*
- **FR-3** Resume from a stored cursor; idempotent re-sync. *Built.*
- **FR-4** Report transactions that could not be fetched (never drop silently). *Built (`skipped` table).*
- **FR-5** Support transactions older than Horizon's window. *Not built (T3); documented limitation.*
- **FR-6** Detect transactions where the address is only an indirect participant (e.g. relayer-sponsored, contract-driven payouts). *Tested on a narrow sample: Horizon listed 5 of 5 Soroswap-router swaps where one account was only the recipient (F-9). Other indirect patterns (vault payouts, multi-hop routers by third parties, SAC transfers inside unrelated transactions) are untested.*

### Decoding and classification
- **FR-10** Normalise CAP-67 `transfer`/`mint`/`burn`/`clawback` events, including the `{amount, to_muxed_id}` data form; skip zero-amount movements. *Built.*
- **FR-11** Resolve SAC contract ids to classic asset keys by learning from event topics. *Built.*
- **FR-12** Net the network fee (charge minus refund) per transaction. *Built.*
- **FR-13** Blend v2 pool decoder: `supply`, `supply_collateral`, `withdraw`, `withdraw_collateral`, `borrow`, `repay`, `claim`. *Built, verified on mainnet data.*
- **FR-14** Soroswap router swap decoder (when `to` is the account). *Built, verified on mainnet data.*
- **FR-15** Generic heuristic: swap, LP add/remove, vault deposit/withdraw, transfers. *Built.*
- **FR-16** Flag contract calls that move no assets for the account as `unclassified`, only for source/fee-paying accounts. *Built.*
- **FR-17** Aquarius, Phoenix, FxDAO, DeFindex decoders. *Not built (T2); schemas not yet read.*

### Accounting
- **FR-20** Price every leg in USD at event time; unpriced legs warn and never guess. *Built.*
- **FR-21** Tax lots per asset with FIFO/LIFO/HIFO; disposals carry basis, proceeds, gain, holding period. *Built.*
- **FR-22** Lending positions: principal and share ledger; withdrawal releases principal proportionally and recognises the remainder as interest. *Built.*
- **FR-23** Reward claims recognised as income at fair value. *Built.*
- **FR-24** Trades dispose the out-asset and acquire the in-asset at fair value. *Built.*
- **FR-25** Liquidity add/remove policy: `disposal` (default) or `carryover`. *Built.*
- **FR-26** Borrow/repay with interest-expense recognition. *Built (simple model).*
- **FR-27** Multi-address ownership: transfers between the user's own addresses are non-taxable. *Built.*
- **FR-28** Warnings for: unpriced, no tracked lots, unknown basis, unclassified, negative interest. *Built.*
- **FR-29** Unrealised/accrued interest for period reports (needs b-rate state reads). *Not built (T2).*

### Output
- **FR-30** Koinly Universal Template CSV. *Built; label mapping unverified against a live import.*
- **FR-31** Events CSV, gains CSV, income CSV, JSON dump. *Built.*
- **FR-32** Balanced double-entry journal for income, fees and gains. *Built (partial journal, see `EXPORTS.md`).*
- **FR-33** QuickBooks/Xero import files. *Not built (T2).*
- **FR-34** HTTP API for classified events and reports. *Specified (T2).*

## 7. Non-functional requirements

- **Correctness over coverage.** Money is integer base units and integer micro-USD; no floating point touches a basis or gain.
- **Determinism.** Same stored transactions + same policy + same prices → byte-identical output. Event ids are `${txHash}:${n}`.
- **Auditability.** Every exported row traces to a transaction hash; JSON export keeps events, warnings and open positions.
- **Privacy.** Public chain data only. No keys, no signing. Local SQLite by default.
- **Performance.** Current: first sync is slow (decode costs 4–8 s per ledger in the JS SDK, measured; see `VERIFIED-FINDINGS.md` F-6). Target T3: <50 ms per ledger with a native decoder. Reports from stored data run in seconds, dominated by price lookups.
- **Honesty about limits** is a requirement, not a nicety: see §11.

## 8. Competitive landscape (from `notes/soroban_ledger_prior_art.md`)

| Layer | Who | Covers | Gap vs this product |
|---|---|---|---|
| Decoded data | Allium (SDF-contracted), Dune, Hubble, wallet-backend, Mercury | Events, some protocol tables, USD at event time | Warehouse/pipe, not a per-address books product; wallet-backend registers only SEP-41 |
| Positions | Smoothie, Dig, OctoPos, Orion (unverified live) | Current positions, health | No lots, income recognition or export |
| Tax vendors | Koinly, Cryptio, Bitwave, CoinLedger, Kryptos, Tres + others | Classic Stellar | No Soroban shown; Allium could let them add it cheaply **[judgment, unverified that any has]** |
| Open source books | Bookee (QuickBooks CSV) | Classic + SAC payments | No DeFi, no basis |
| Dead attempts | LedgersTax, KwickBit | — | See §2 |

## 9. The demand risk, stated plainly

Two prior attempts died, one citing weak SMB demand. The market is small: secondary figures put Blend TVL near $110M and DEX TVL near $26M in Q1 2026 (`notes/soroban_ledger_prior_art.md`, honest assessment). **Building before validating repeats their mistake.** Therefore:

- **Gate G1 (before any T2 work):** 8 of 10 interviews (`VALIDATION.md`) with Soroban DeFi users/treasuries completed, and **at least 3 say they would pay or have paid someone for this problem**, or at least 2 tax/wallet vendors say they would integrate a feed.
- **Kill criteria:** fewer than 2 would-pay signals and no vendor interest after 10 interviews → stop, keep the engine as open-source infrastructure, do not build T2.
- **Pivot options if kill:** (a) sell classified-event feed to Allium-class vendors; (b) the same engine as the accounting layer for RWA holders when DTCC-era assets arrive **[judgment]**; (c) donate to SDF's wallet-backend as a Blend/Soroswap protocol processor (it has a `ProtocolProcessor` extension point, `notes/soroban_ledger_prior_art.md`).

## 10. Distribution and pricing hypotheses (all **[judgment]**, test in interviews)

1. **Open-source core + hosted convenience.** Free CLI/library builds trust and decoders; hosted sync and exports are the paid part.
2. **Vendor-as-channel.** Koinly CSV first, so users with existing tax software need no switch; later a feed/API for vendors.
3. **Treasury tier.** DAOs pay for monthly journal exports with audit trail.
4. **Grant funding.** An SCF infrastructure grant is plausible for the open decoder library; SDF has SDK/infra programmes (`notes/scf_register_tooling_infra_D1.md`).

## 11. Known limitations (carry into every release note)

1. **History window.** Discovery uses Horizon, whose earliest ledger today is 58,812,481 (≈ 2025-09-07). Older activity needs another discovery source (T3).
2. **Indirect participation only narrowly tested (R-1).** Horizon listed 5 of 5 router swaps where one account was only the recipient (F-9). One recipient account and one protocol were tested; other patterns are not.
3. **Slow first sync** (F-6): 4–8 s CPU per ledger.
4. **Pricing:** SDEX-only plus a USDC peg. Soroban-AMM-only and illiquid assets are unpriced (warned). A depeg of USDC is not modelled.
5. **Decoders:** Blend v2 and Soroswap router only. Blend `claim` does not name the emission asset; it is inferred from the matching transfer.
6. **Interest** is recognised on withdrawal (realised). Accrual between withdrawals needs state reads (T2).
7. **Accounting policy** defaults are conventional, not authoritative; no jurisdiction guidance exists for Soroban. See `ACCOUNTING-POLICY.md`.
8. **Koinly label mapping unverified** against a live import.
9. **Decimals:** non-SAC SEP-41 tokens default to 7 decimals unless configured; wrong for tokens with other decimals.

## 12. Success metrics

- **Validation:** G1 above.
- **Correctness:** on a corpus of ≥ 20 real addresses, ≥ 95% of events classified `exact`/`heuristic` with no warning other than `no_lots` for pre-window history; hand-audit of 50 random events against the explorer shows zero amount errors.
- **Reconciliation:** for Blend positions, reconstructed principal + interest equals pool-reported position value within 1 unit (T2 check using state reads).
- **Adoption (if G1 passes):** 25 active addresses synced by 10 distinct users in 60 days; ≥ 1 vendor integration LOI.

## 13. Open questions

1. Which jurisdictions do the target users file in, and what treatment do their accountants expect for supply/LP/vault shares?
2. Does Horizon list *every* indirect-recipient pattern (R-1)? 5/5 listed in the one case tested (F-9); extend the test to vault payouts and SAC transfers inside unrelated transactions.
3. Will any tax vendor accept a third-party CSV generator as a documented source, or only direct integrations?
4. Aquarius, Phoenix, FxDAO, DeFindex event schemas: not yet read.
5. Is Allium's Stellar data licensable to resell classified events, or only to use as a source?
6. How should DTCC-era permissioned assets (registered wallets) be represented, if at all?

## 14. Related documents

`SPEC.md` (technical design) · `DECODERS.md` · `ACCOUNTING-POLICY.md` · `EXPORTS.md` · `BUILD-PLAN.md` · `VALIDATION.md` · `VERIFIED-FINDINGS.md`
