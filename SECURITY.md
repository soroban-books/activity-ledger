# Security policy

## What this project is, for threat-modelling

`activity-ledger` is a local tool. It reads public Stellar data, stores it in a SQLite file on your machine, and serves a web UI on loopback. It has **no keys, no signing and no transaction sending**. It never asks for a secret.

## Reporting a vulnerability

Please do **not** open a public issue for a security problem.

Use GitHub's private reporting: on the repository, go to **Security > Advisories > Report a vulnerability**. If that option is not shown, open a regular issue that says only "security report, please contact me" with no details, and a maintainer will arrange a private channel.

Include what you found, how to reproduce it, and the impact you see. We aim to acknowledge a report within 7 days and to tell you what we plan to do within 30. This is a volunteer project, so those are targets, not guarantees. We will credit you in the advisory if you wish.

## In scope

- The local web server (`src/server.ts`) and UI (`web/`): DNS rebinding, cross-site requests, script injection from chain-derived text (notes, counterparties, asset codes), path traversal, request-size or resource exhaustion.
- Anything that could leak or corrupt the local database, or execute code, from data fetched from Horizon, the data lake or RPC (malformed XDR, hostile contract events).
- Supply-chain problems in how the package is built or published.

## Out of scope

- **Wrong accounting numbers or misclassified transactions.** These are bugs, not vulnerabilities: open a normal issue with the transaction hash.
- Anything that needs an attacker who already controls your machine or your local database.
- Findings against the public services the tool calls (Horizon, the AWS data lake, RPC providers); report those to their operators.
- The privacy property that querying a service reveals the address you query to that service. This is documented in the README.

## Hardening already in place

The server binds to loopback only, rejects unexpected `Host` headers, requires `application/json` for writes, caps request size, serves static files from one directory with traversal checks, and sends a strict Content-Security-Policy. Chain-derived text is rendered as text. These are covered by tests in `test/server.test.ts`.

## Supported versions

Only the latest release and the `main` branch receive fixes while the project is `0.x`.
