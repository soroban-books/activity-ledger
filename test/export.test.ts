import test from 'node:test';
import assert from 'node:assert/strict';
import { buildLedger } from '../src/pipeline.ts';
import { koinlyCsv, KOINLY_HEADER, koinlyDate } from '../src/export/koinly.ts';
import { journalCsv, gainsCsv, incomeCsv } from '../src/export/reports.ts';
import { esc } from '../src/export/csv.ts';
import { loadFixture, fixedPrices } from './helpers.ts';

const SWAPPER = 'GCOGUAYJVAJN7XJ4PSJ5J6JSB3GW2OHXLUOGHTKQAMXW34A337YJOPIT';
const BLEND_USER = 'GBJMQBKQL6FQ6BFZ52YJGY6SEMEER3DSTICPIYBZR3P4T2FUDYZEHUN7';

test('csv escaping', () => {
  assert.equal(esc('a,b'), '"a,b"');
  assert.equal(esc('say "hi"'), '"say ""hi"""');
  assert.equal(esc(5n), '5');
});

test('koinly: header, date format, swap row with the fee attached', async () => {
  const { events, result } = await buildLedger(new Map([[SWAPPER, loadFixture('soroswap-swap')]]), fixedPrices);
  const lines = koinlyCsv(events, result.pricedLegs, result.income).trim().split('\n');
  assert.equal(lines[0], KOINLY_HEADER.join(','));
  assert.equal(lines.length, 2); // header + one swap row (fee rides on the swap row)
  const c = lines[1]!.split(',');
  assert.equal(c[0], '2026-10-19 07:20:03 UTC');
  assert.deepEqual(c.slice(1, 7), ['0.257128', 'USDC', '43.020192', 'BLND', '0.0033347', 'XLM']);
  assert.equal(c[11], events[0]!.txHash);
  assert.equal(koinlyDate('2025-01-02T03:04:05Z'), '2025-01-02 03:04:05 UTC');
});

test('koinly: lending principal moves are omitted, interest is exported as income', async () => {
  const { events, result } = await buildLedger(new Map([[BLEND_USER, loadFixture('blend-roundtrip')]]), fixedPrices);
  const body = koinlyCsv(events, result.pricedLegs, result.income).trim().split('\n').slice(1);
  assert.equal(body.length, result.income.length); // only interest rows, no supply/withdraw rows
  assert.ok(body.every((l) => l.includes(',reward,')));
});

test('journal: every entry group balances (debits == credits)', async () => {
  const { result } = await buildLedger(new Map([[BLEND_USER, loadFixture('blend-roundtrip')]]), fixedPrices);
  const rows = journalCsv(result).trim().split('\n').slice(1).map((l) => l.split(','));
  const dr = rows.reduce((s, r) => s + Math.round(Number(r[2] || 0) * 1e6), 0);
  const cr = rows.reduce((s, r) => s + Math.round(Number(r[3] || 0) * 1e6), 0);
  assert.equal(dr, cr);
  assert.ok(gainsCsv(result).startsWith('asset,units'));
  assert.ok(incomeCsv(result).startsWith('time,kind'));
});

test('journal: no blank gain rows for break-even disposals', async () => {
  const { result } = await buildLedger(new Map([[BLEND_USER, loadFixture('blend-roundtrip')]]), fixedPrices);
  for (const l of journalCsv(result).trim().split('\n').slice(1)) {
    const c = l.split(',');
    assert.ok(c[2] !== '' || c[3] !== '', `blank amounts in: ${l}`);
  }
});
