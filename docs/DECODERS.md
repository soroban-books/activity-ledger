# Protocol decoders

A decoder turns a protocol's contract events into exact `LedgerEvent`s and **claims** the CAP-67 transfers that moved the underlying assets, so nothing is counted twice. Without a decoder, the generic heuristic (`SPEC.md` §5) still classifies swaps, liquidity and vault shares, but cannot tell supply from sale, repay from payment, or compute interest.

## Contract for a decoder (`src/classify/ctx.ts`)

```ts
type Decoder = (ctx: ClassifyCtx) => LedgerEvent[]
// ctx: { tx, account, reg (asset registry), flows (CAP-67), claimed:Set<eventIndex>, next() }
```
Rules: (1) emit only events whose user is `ctx.account`; (2) call `claimFlow` for every transfer the protocol event explains; (3) set `confidence: 'exact'` only when the amounts come straight from the protocol event; (4) never throw on an unexpected shape, skip it so the generic path handles it; (5) ship a mainnet fixture and a test with exact amounts before merging.

## Built

### Blend v2 (`src/classify/blend.ts`, `src/blend/`)
Sources: `blend-capital/blend-contracts-v2` `pool/src/events.rs`, `backstop/src/events.rs`, `pool-factory/`. Interest is **never an event**: it comes from share ledgers (`ledger/positions.ts` for b-tokens and backstop shares, `ledger/debt.ts` for d-tokens).

**Which contracts are Blend (F-15).** Event shape is not proof: a non-Blend contract emitted 170 `flash_loan` events in the exact Blend shape. A pool is accepted only if it is in the seed list (`blend/directory.ts`) or a Blend pool factory deployed it. That is checked once via RPC `getLedgerEntries` on the factory's `Contracts(pool)` storage key (`blend/factory.ts`), then cached in the `blend_contracts` table (positives forever, negatives one day, failures never). If RPC is unreachable the contract is `unverified`: not decoded, and a warning says so. The backstop is a singleton per version (seeded).

| Event (contract) | Topics | Data | LedgerEvent | Mainnet-verified |
|---|---|---|---|---|
| `supply`, `supply_collateral` (pool) | `[name, asset, from]` | `[tokens_in, b_minted]` | `lend_supply`, position `blend` +shares | yes |
| `withdraw`, `withdraw_collateral` | `[name, asset, from]` | `[tokens_out, b_burnt]` | `lend_withdraw`, position `blend` -shares | yes |
| `borrow` | `[name, asset, from]` | `[tokens_out, d_minted]` | `borrow`, position `blend-debt` +shares | **no** (none in the 7-day window; spec + synthetic tests) |
| `repay` | `[name, asset, from]` | `[tokens_in, d_burnt]` | `repay`, position `blend-debt` -shares | yes (liquidator repay, real) |
| `flash_loan` | `[name, asset, from, contract]` | `[tokens_out, d_minted]` | `borrow` with no cash leg (loan goes to the receiver contract) | **no** (only the lookalike emitted it) |
| `claim` | `[name, from]` | `[reserve_ids, amount]` | `reward_claim`; asset comes from the matching inbound transfer | partly (events seen, not captured as a fixture) |
| `new_auction`, `delete_auction` | `[name, type, user]` | `[percent, AuctionData]`, `()` | `no_op` notice when `user` is the account | yes (real) |
| `fill_auction` type 0 | `[name, type, user]` | `[filler, percent, AuctionData]` | `liquidation` with `positions[]`: victim collateral/debt `out`, filler `in` | yes (real: 7 fills, 3 victims, contract and G-account fillers) |
| `fill_auction` type 1, 2 | same | same | `no_op`; token movements stay with the generic classifier | no |
| `bad_debt` | `[name, user, asset]` | `d_tokens` | `liquidation` (debt moved to backstop) | no |
| `deposit` (backstop) | `[name, pool, from]` | `[tokens_in, shares_minted]` | `lend_supply`, position `blend-backstop` | **no** (backstop had zero events in the window) |
| `withdraw` (backstop) | `[name, pool, from]` | `[shares_burnt, tokens_out]` (**shares first**) | `lend_withdraw`, position `blend-backstop` | no |
| `queue_withdrawal`, `dequeue_withdrawal`, backstop `claim` | `[name, pool, from]` / `[name, from]` | `[shares, expiration]` / `shares` / `lp_amount` | `no_op`, `no_op`, `reward_claim` (LP tokens) | no |
| `gulp`, `set_status`, emissions admin, … | | | `no_op` when the account called it, so it is not flagged unclassified | n/a |

**Rules that make the numbers right**
- `from` is the position owner, not necessarily the wallet that paid or received (`submit` has separate `spender` and `to`). A cash leg is booked only if a matching CAP-67 transfer really touches this account. Otherwise the event is `unclassified` with an explicit note and no wallet movement.
- **Borrow interest is per d-token share**, per pool and asset: repaying 550 for 500 of 1,000 d-tokens books 50 of interest, not 0. Debt older than the sync window is never guessed: the repay is booked as a disposal, the interest is not split, and `unknown_debt` is raised.
- **Liquidations are not valued.** Seized collateral and cleared debt are share moves; their USD value needs the pool's `b_rate`/`d_rate` at that ledger (a state read, milestone M5). The share ledgers are updated so later events stay consistent, no gain or loss is booked, and `liquidation_unvalued` states the amounts. A liquidator's assumed collateral and debt are not tracked, so its later withdrawals and repays raise `unknown_basis` / `unknown_debt`. The profit of a liquidation is therefore **not** recognised yet.
- Backstop interest is realised in LP tokens on withdrawal (same mechanism as lending). The comet LP token has no SDEX price, so it is `unpriced` until M5.

**Not built / not verified**
- v1 pools verify through the v1 factory and are decoded with the v2 shapes; v1 event shapes were not checked.
- No fixture for borrow, flash loan, backstop or `claim` on mainnet: their tests build events from the contract source and are labelled synthetic. Capture real ones when activity appears (use `scripts/blend-probe-names.ts` to find them).
- Accrued but unwithdrawn interest (needs `b_rate` reads), liquidation valuation, `defaulted_debt` (pool-level, not user-facing).

### Soroswap router swap (`src/classify/soroswap.ts`) — verified (F-12)
`["SoroswapRouter","swap"]`, data `{amounts, path, to}`. Exact trade when `to === account`: input = `amounts[0]` of `path[0]`, output = last of each. When `to` is another contract (aggregators, vaults), it falls through to the generic path. Pair events (`["SoroswapPair","swap"|"deposit"|"withdraw"|"sync"]`) only set `protocol: 'soroswap'` on generic events because they omit token addresses and `to` is not always the user.

### Generic heuristic (`src/classify/generic.ts`)
Documented in `SPEC.md` §5. `confidence: 'heuristic'`. Fixture test shows it reproduces the Soroswap swap exactly from transfers alone.

## Specified, not built (T2), in priority order

| Protocol | What is needed | Read first |
|---|---|---|
| **Aquarius** (AMM, pools, rewards) | Read the pool contract source (no public repo was located by the discovery pass; only `AquariusDeFi/dao-aquarius-soroban` surfaced) and a mainnet sample | `notes/soroban_ledger_prior_art.md` |
| **Phoenix** (AMM) | Same | — |
| **DeFindex / vault shares** | Share-token mint/burn plus underlying; likely covered by generic `vault_*` but needs exact share price for NAV-accrual income | — |
| **FxDAO** (stablecoin vaults) | Collateral and debt events | — |
| **Blend auctions & backstop** | `fill_auction`, backstop deposit/queue/withdraw, liquidation treatment | Blend `events.rs`, `backstop/` |
| **RWA yield/NAV tokens** | NAV accrual and distribution events per issuer; SEP-57 T-REX tokens | `notes/rwa_issuer_platform_screen.md` |

## Verification rule for every new decoder
1. Pull ≥ 20 real transactions from the lake (`scripts/capture-fixture.ts`).
2. Assert exact amounts for at least one event of each kind.
3. Run the conservation or reconciliation check that fits the protocol (Blend: principal + interest). 
4. Differential check against Allium's table for the same protocol where one exists **[T2]**.
