# Demand validation (Gate G1)

Note: the `notes/` files cited here are private and not in this repository, so these competitor claims are unverified.

Why this exists: LedgersTax and KwickBit both built this and stopped; KwickBit's own tracker says its surveys "revealed that the business potential for a crypto accounting tool targeting small and medium businesses is low" (`notes/soroban_ledger_prior_art.md`). Engineering is cheap relative to repeating that mistake.

## Who to talk to (target 10, at least 4 groups)
1. **Soroban DeFi power users**: addresses with many Blend/Soroswap events (the lake and RPC show who they are; `scripts/find-blend-roundtrip.mjs` lists active Blend users). Reach through community channels, not by cold-messaging wallet owners from chain data.
2. **DAO / protocol treasury operators** on Stellar.
3. **Accountants or bookkeepers** serving crypto clients (ask one who already handles Stellar).
4. **Tax-vendor and wallet product people** (Koinly support/product, Bitwave, a wallet team): "would you accept a classified-event feed?"
5. **Allium or SDF DevRel**: is classified Stellar data licensable or is a community decoder library welcome (wallet-backend `ProtocolProcessor`)?

## Interview script (30 min)
1. What Stellar/Soroban DeFi have you used in the last 12 months? Which protocols?
2. Last tax season / month-end: what did you do about it? Tools? Time spent? Who did it?
3. Show me what you have today (screen share). Where does it break for Soroban?
4. What did you get wrong, or leave out, because it was too hard?
5. What would a good answer look like? Format (CSV into Koinly? journal? PDF?)
6. If this existed and was correct, how would you pay? Price you would pay per year / per month? Who approves?
7. Who else has this problem? Can I talk to them?
Do **not** pitch before question 6. Do not ask leading questions ("would you use a tool that…").

## Signals
| Strong | Weak |
|---|---|
| Paid someone or lost hours this year; can show the spreadsheet | "That sounds useful" |
| Names a price or a budget owner | "Maybe later" |
| Offers a real address to test on | Only asks for it to be free |
| Vendor says "send me a sample feed" | Vendor says "we'll watch Stellar" |

## Decision rule
- **Continue to M3+:** ≥ 3 interviewees would pay (or have paid) **or** ≥ 2 vendors will integrate/trial a feed.
- **Narrow:** demand only from treasuries or only from vendors → build that tier only.
- **Stop:** < 2 would-pay signals and no vendor interest after 10 interviews. Keep the engine open source and pursue the pivots in PRD §9.

## Free evidence to gather first (no interviews)
- Count active Soroban DeFi addresses per month from the lake (events by `from` per protocol) to size the market honestly.
- Search Koinly/Reddit/Discord for "Soroban"/"Blend tax" complaints (the discovery found 0 Soroban threads on Koinly's forum; re-check).
- Run the CLI on 20 active addresses and measure how many events land `unclassified` — the product's value is proportional to what it explains.
