## What and why

<!-- One concern per pull request. Link the issue if there is one. -->

## How it was checked

<!-- Tests added or changed, and for decoders: which real mainnet transaction hashes the fixture comes from. -->

## Checklist

- [ ] `pnpm test` and `pnpm typecheck` pass, and the tests stay offline
- [ ] No floating point touches an amount, basis or gain
- [ ] Anything unverified is labelled as such (for example a synthetic test in place of a mainnet fixture)
- [ ] A change to a report number updates `docs/ACCOUNTING-POLICY.md`
- [ ] `CHANGELOG.md` updated under Unreleased for user-visible changes
- [ ] No databases, caches, secrets or personal data committed
