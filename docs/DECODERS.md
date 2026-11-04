# Protocol decoders

A decoder turns a protocol's contract events into exact `LedgerEvent`s and **claims** the CAP-67 transfers that moved the underlying assets, so nothing is counted twice. Without a decoder, the generic heuristic (`SPEC.md` §5) still classifies swaps, liquidity and vault shares, but cannot tell supply from sale, repay from payment, or compute interest.

## Contract for a decoder (`src/classify/ctx.ts`)

```ts
type Decoder = (ctx: ClassifyCtx) => LedgerEvent[]
// ctx: { tx, account, reg (asset registry), flows (CAP-67), claimed:Set<eventIndex>, next() }
```
Rules: (1) emit only events whose user is `ctx.account`; (2) call `claimFlow` for every transfer the protocol event explains; (3) set `confidence: 'exact'` only when the amounts come straight from the protocol event; (4) never throw on an unexpected shape, skip it so the generic path handles it; (5) ship a mainnet fixture and a test with exact amounts before merging.

## Built

### Blend v2 (`src/classify/blend.ts`) — verified on mainnet (F-11)
Source: `blend-capital/blend-contracts-v2`, `pool/src/events.rs`.

| Event | Topics | Data | LedgerEvent |
|---|---|---|---|
| `supply`, `supply_collateral` | `[name, asset, from]` | `[tokens_in, b_tokens_minted]` | `lend_supply` (out leg `tokens_in`, position +shares) |
| `withdraw`, `withdraw_collateral` | `[name, asset, from]` | `[tokens_out, b_tokens_burnt]` | `lend_withdraw` (in leg, position −shares) |
| `borrow` | `[name, asset, from]` | `[tokens_out, d_tokens_minted]` | `borrow` |
| `repay` | `[name, asset, from]` | `[tokens_in, d_tokens_burnt]` | `repay` |
| `claim` | `[name, from]` | `[reserve_token_ids, amount_claimed]` | `reward_claim`; the emission asset is **not in the event**, so it is taken from the matching inbound transfer of the same amount |

Not decoded yet: `flash_loan`, `new_auction`/`fill_auction`, `bad_debt`, `defaulted_debt`, backstop events (`deposit`, `queue_withdrawal`, `draw`, …), Blend v1 pools. **Interest is not an event**; it is derived at withdrawal from the share ledger (`SPEC.md` §6.3). Pools are recognised by event shape, not by a pool allow-list, so any Blend pool works, but a non-Blend contract emitting the same shape would be misread. T2: restrict to pools created by the Blend pool factory.

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
