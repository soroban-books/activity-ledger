# Exports

All files are written by `node src/cli.ts export <G...> --out <dir> [--format …]` (default `all`). Money columns are decimal strings in whole units (assets) or USD.

| File | Contents | Consumer |
|---|---|---|
| `koinly.csv` | Koinly Universal Template: one row per sent/received movement, fee attached to the first row of a transaction, interest/reward rows with a label | Koinly import |
| `events.csv` | Every classified event: id, time, ledger, tx, kind, protocol, confidence, legs, USD value, counterparty, note | Auditors, debugging |
| `gains.csv` | One row per disposal lot: asset, units, acquired, disposed, proceeds, basis, gain, short/long | Tax preparation |
| `income.csv` | Interest and reward income with price source and event id | Tax preparation, bookkeeping |
| `journal.csv` | Double-entry lines for income, fees, borrow interest and realised gains (debits = credits) | Accountants |
| `ledger.json` | Events, warnings, open positions (bigints as strings) | Other software |

## Koinly (read before relying on it)
- Header and date format (`YYYY-MM-DD HH:mm:ss UTC`) follow Koinly's published Universal Template.
- **The label values are my best mapping and have not been verified against a live import.** They are in `LABELS` at the top of `src/export/koinly.ts` (`interest`/`reward` → `reward`, liquidity → `liquidity in`/`liquidity out`, fee-only → `cost`). Do one real import and fix the map.
- Lending principal moves (supply/withdraw/borrow/repay) are **omitted** (non-taxable carryover); only the income they generate is exported. If the user's policy differs, Koinly will not see those flows.
- Trades with several legs on one side are split into multiple one-sided rows.
- Koinly performs its own cost basis; the CSV supplies facts and USD net worth, not our lots. Our `gains.csv` and Koinly's report can differ because of different policy; compare before filing.

## Journal limitations
The journal covers income, fees, borrow interest and gains. It is not a full general ledger: acquisitions and asset-to-asset movements are tracked in lots, not journaled. Disposal proceeds are posted to `Clearing:Disposal proceeds`. Use it as supporting schedule, not as a trial balance.

## Planned (T2)
QuickBooks Online and Xero import files; per-period (monthly) income summary; accrual-basis interest once state reads exist; an `opening.csv` import for pre-window balances.
