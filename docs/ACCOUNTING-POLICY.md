# Accounting policy

**This is not tax advice.** There is no authoritative guidance for Soroban DeFi in most jurisdictions, and vendors themselves tell users to "manually adjust or tag" such transactions (Koinly forum, per `notes/soroban_ledger_prior_art.md`). The defaults below are conventional and conservative; every one is explicit, configurable where noted, and printed in exports so an accountant can disagree with it.

Config object: `Policy` in `src/ledger/engine.ts` (`lotMethod`, `lp`, `lending`, `ownAddresses`). CLI flags: `--method`, `--lp`.

| Event | Default treatment | Alternatives | Why this default |
|---|---|---|---|
| Receive asset (transfer in) | Acquisition at fair value on receipt | Treat as own-wallet transfer via `ownAddresses` (no lot change) | Without knowing the sender, fair value is the only defensible basis; pooling your own addresses avoids false gains |
| Send asset (transfer out) | Disposal at fair value | Own-wallet transfer ignored | A payment to a third party is a spend |
| Trade / swap | Disposal of out-asset(s), acquisition of in-asset(s) at fair value of what was received (fallback: of what was given) | — | Standard |
| Add liquidity / vault deposit | **Disposal** of deposited assets, acquisition of the share token at their value | `--lp carryover`: basis moves into the share token, no gain | Matches common tax-tool defaults; carryover is the position-neutral reading |
| Remove liquidity / vault withdraw | Disposal of the share token, acquisition of received assets | carryover mirror | Mirror of the above |
| Lending supply (Blend) | **Non-taxable carryover**: lots move into the position keeping basis and acquisition date | `lending: 'disposal'` | Depositing into a lending pool is commonly treated as a non-disposal; this is the most contested default |
| Lending withdraw | Principal returns with original basis/dates; the excess over principal is **interest income** at fair value on withdrawal | — | Income recognised when realised (received) |
| Borrow | Acquisition at fair value, debt recorded; no income | — | A loan is not income |
| Repay | Disposal of repaid units; repayment above tracked debt = **borrow interest expense** | — | Standard |
| Borrow interest (Blend) | Per d-token share, per pool and asset: repaying burns shares, releases that fraction of principal, and the excess is a `borrow_interest` expense at fair value | — | Interest accrues in the d-token rate, so proportional is the economic reading |
| Liquidation, victim (Blend) | **Disposal** of the seized collateral for the value of the debt it relieves (proceeds = debt cleared); tokens of cleared debt beyond tracked principal are borrow interest. Valued with rates implied by pool events within about 3 days | Treat as no disposal; or proceeds = collateral market value (then the penalty is an expense) | Common reading: collateral is surrendered in satisfaction of debt. Contested |
| Liquidation, liquidator (Blend) | Collateral acquired with a basis equal to the value of the debt assumed; the discount is realised when the collateral is later sold. Assumed debt is tracked | Recognise the bonus as income at fill time | Nothing is received in cash at fill time |
| Reward claim (e.g. BLND) | **Income** at fair value on claim; new lot at that value | — | Income on receipt |
| Network fee | Disposal of native at fair value + `network_fee` expense | — | Conservative: fee is a spend; accountants may prefer folding into basis |
| Unclassified contract call | No lot change; `unclassified` warning | — | Honest about not knowing |

## Lot methods
FIFO (default), LIFO, HIFO. Holding period: **long-term when held > 365 days** (a US-style threshold used for the `term` column; not applied to any other jurisdiction's rules).

## Pricing assumptions
USD at event time from: manual CSV → USDC peg (assumed $1.00, depegs not modelled) → SDEX hourly close (direct to USDC, else via XLM). An unpriced leg is **never guessed**: the engine warns and uses null/zero. Illiquid and Soroban-AMM-only assets are therefore unpriced until a source is added.

## Warnings emitted
`unpriced`, `no_lots` (disposal with no tracked acquisition, e.g. history before the sync window), `unknown_basis` (withdrawal of shares deposited before the window), `unclassified`, `negative_interest` (withdrew less than principal), `lp_value_unpriced`, `unknown_debt` (repay or liquidation of debt borrowed before the sync window: interest cannot be split), `liquidation_estimated` (valued with implied pool rates; states their distance), `liquidation_unvalued` (no rate or price nearby: nothing booked).

## Known gaps
- Accrued-but-unwithdrawn interest is not recognised (needs state reads, T2).
- Wash-sale, de-minimis, jurisdiction-specific lot rules, and Form 8949 formatting are out of scope.
- Interest from `negative_interest` events (pool losses) is warned, not booked as a loss.
- Basis for assets received before the sync window is unknown; the user must supply a manual opening-balance file (T2: `opening.csv`).
