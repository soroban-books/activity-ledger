# Contributing

Thanks for helping. This project is small and the bar is simple: **correct numbers, honestly labelled.** A wrong amount in someone's tax books is worse than a missing feature, so changes are judged on evidence, not volume.

By taking part you agree to follow the [Code of Conduct](CODE_OF_CONDUCT.md). By contributing you agree your work is released under the [MIT license](LICENSE).

## Setup

Node 22.18 or newer (CI and the author use 24) and pnpm.

```bash
pnpm install
pnpm test        # offline, uses fixtures/, takes a few seconds
pnpm typecheck
pnpm build       # compiles to dist/
node src/cli.ts serve   # try the web UI
```

TypeScript runs directly through Node's type stripping, so only erasable syntax is allowed: no `enum`, no constructor parameter properties, no `namespace`. `tsc --noEmit` enforces it.

## Where things are

```
src/sources/    Horizon, Galexie lake reader, Soroban RPC, resilient HTTP
src/classify/   protocol decoders and the generic flow heuristic
src/blend/      Blend pool verification and implied exchange rates
src/ledger/     lots, positions, debt shares, the accounting engine
src/pricing/    price providers
src/export/     Koinly, events, gains, income, journal
src/server.ts   local web server;  web/  the UI (plain JS, Primer CSS)
test/ fixtures/ offline tests and real mainnet transactions
scripts/        probes, profiling and fixture capture (not shipped)
docs/           design, decoders, accounting policy, verified findings
```

## Ground rules

1. **Tests are offline.** No test may touch the network. Use `fixtures/` and inject price providers and lookups.
2. **Money is integers.** Amounts are `bigint` base units and USD is integer micro-USD. No floating point may touch a basis, gain or amount. (Test files may use floats only for independent tolerance checks.)
3. **Never guess silently.** An unpriced leg, an unknown basis or an unverified contract produces a warning, not a made-up number.
4. **Never throw on unexpected chain data.** A decoder that does not recognise a shape skips it so the generic path handles it.
5. **Chain text is untrusted.** The UI renders it with `textContent`, never `innerHTML`.

## Adding or changing a protocol decoder

This is the most valuable contribution. Follow the contract in [`docs/DECODERS.md`](docs/DECODERS.md):

1. Read the protocol's contract source and write down each event's topics and data.
2. Capture **real mainnet transactions** as a fixture: `node scripts/capture-fixture.ts <name> <tx-hash>...`. For finding recent examples see `scripts/blend-probe-names.ts`.
3. Decode only contracts you can prove belong to the protocol (see how `src/blend/` verifies pools). Event shape alone is not proof.
4. Emit events only for the account being classified, and claim every transfer the protocol event explains so nothing is counted twice.
5. Assert exact amounts for at least one event of each kind, and add a conservation or reconciliation check that fits the protocol.
6. **Label what is verified.** If a path has no mainnet fixture because no activity could be found, say so in `docs/DECODERS.md` and name the tests synthetic. Do not present a spec-derived test as mainnet-verified.
7. Record any surprise in `docs/VERIFIED-FINDINGS.md` with how you checked it.

## Accounting changes

Anything that changes a number in a report (lot matching, income recognition, liquidation treatment) must update [`docs/ACCOUNTING-POLICY.md`](docs/ACCOUNTING-POLICY.md) in the same pull request, state the alternative treatments, and keep the default conventional. This is not tax advice and the docs must keep saying so.

## Pull requests

- Open an issue first for anything large, so we agree on the approach.
- Keep a pull request to one concern, with tests. `pnpm test` and `pnpm typecheck` must pass; CI runs both plus the build.
- Write commit messages in the conventional style (`feat:`, `fix:`, `test:`, `docs:`, `perf:`, `chore:`), subject under about 70 characters, with a body when the reason is not obvious.
- Update [CHANGELOG.md](CHANGELOG.md) under `Unreleased` for user-visible changes.
- Do not commit databases (`*.sqlite`), caches, `out/`, secrets or personal data. Addresses in fixtures must be public mainnet addresses.

## Reporting problems

- Wrong numbers or a misclassified transaction: open a bug with the transaction hash and what you expected. Hashes and addresses are public chain data and are fine to share.
- Security issues: do **not** open a public issue. See [SECURITY.md](SECURITY.md).
