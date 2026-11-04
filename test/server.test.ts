import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Store } from '../src/store.ts';
import { startServer } from '../src/server.ts';
import { loadFixture, fixedPrices } from './helpers.ts';

const BLEND_USER = 'GBJMQBKQL6FQ6BFZ52YJGY6SEMEER3DSTICPIYBZR3P4T2FUDYZEHUN7';
let nextPort = 46000 + Math.floor(Math.random() * 900);

async function withServer(fn: (base: string, port: number) => Promise<void>): Promise<void> {
  const PORT = nextPort++;
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'al-server-'));
  const db = path.join(dir, 'ledger.sqlite');
  const seed = new Store(db);
  for (const tx of loadFixture('blend-roundtrip')) seed.putTx(BLEND_USER, tx);
  seed.close();
  const server = await startServer({ db, port: PORT, prices: fixedPrices });
  try {
    await fn(`http://localhost:${PORT}`, PORT);
  } finally {
    await new Promise((r) => server.close(r));
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

test('server: lists stored accounts and serves the UI', async () => {
  await withServer(async (base) => {
    const accounts = (await (await fetch(`${base}/api/accounts`)).json()) as { accounts: { account: string; txs: number }[] };
    assert.equal(accounts.accounts[0]!.account, BLEND_USER);
    assert.ok(accounts.accounts[0]!.txs > 0);
    const html = await (await fetch(`${base}/`)).text();
    assert.match(html, /Activity Ledger/);
  });
});

test('server: report recognises Blend interest and exports match', async () => {
  await withServer(async (base) => {
    const r = (await (await fetch(`${base}/api/report?accounts=${BLEND_USER}`)).json()) as {
      totals: { events: number; income: { interest: string } };
      events: { kind: string; usd: string | null }[];
    };
    assert.ok(r.totals.events > 0);
    assert.ok(Number(r.totals.income.interest) > 0, 'interest income recognised');
    const journal = await (await fetch(`${base}/api/export?accounts=${BLEND_USER}&format=journal`)).text();
    assert.match(journal, /Income:Lending interest/);
    const res = await fetch(`${base}/api/export?accounts=${BLEND_USER}&format=koinly`);
    assert.match(res.headers.get('content-disposition') ?? '', /koinly\.csv/);
  });
});

test('server: rejects bad input, foreign hosts, traversal and non-JSON posts', async () => {
  await withServer(async (base, PORT) => {
    assert.equal((await fetch(`${base}/api/report?accounts=nope`)).status, 400);
    assert.equal((await fetch(`${base}/api/report?accounts=${BLEND_USER}&method=XYZ`)).status, 400);
    assert.equal((await fetch(`${base}/api/export?accounts=${BLEND_USER}&format=zip`)).status, 400);
    assert.equal((await fetch(`${base}/api/sync`, { method: 'POST', body: '{}' })).status, 415);
    const bad = await fetch(`${base}/api/sync`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ accounts: BLEND_USER, limit: -1 }) });
    assert.equal(bad.status, 400);
    const traversal = await fetch(`${base}/..%2f..%2fpackage.json`);
    assert.ok([403, 404].includes(traversal.status), `traversal must not be served, got ${traversal.status}`);
    assert.doesNotMatch(await traversal.text(), /activity-ledger"/);
    const status = await new Promise<number>((resolve, reject) => {
      http.get({ host: '127.0.0.1', port: PORT, path: '/api/accounts', headers: { host: 'evil.example' } }, (res) => { res.resume(); resolve(res.statusCode ?? 0); }).on('error', reject);
    });
    assert.equal(status, 403);
  });
});
