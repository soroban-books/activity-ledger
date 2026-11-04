import test from 'node:test';
import assert from 'node:assert/strict';
import { LotBook } from '../src/ledger/lots.ts';
import { Positions } from '../src/ledger/positions.ts';
import { Engine, byChronology } from '../src/ledger/engine.ts';
import { fmtUnits, fmtUsd, valueMicro } from '../src/ledger/money.ts';
import { buildLedger } from '../src/pipeline.ts';
import { loadFixture, fixedPrices, USDC, BLND } from './helpers.ts';

const BLEND_USER = 'GBJMQBKQL6FQ6BFZ52YJGY6SEMEER3DSTICPIYBZR3P4T2FUDYZEHUN7';
const SWAPPER = 'GCOGUAYJVAJN7XJ4PSJ5J6JSB3GW2OHXLUOGHTKQAMXW34A337YJOPIT';

test('money: valueMicro and formatting are exact', () => {
  assert.equal(valueMicro(2_571_280n, 7, 1_000_000n), 257_128n); // 0.257128 USDC = $0.257128
  assert.equal(valueMicro(1n, 7, 5_000_000n), 1n); // rounds half up: 0.5 micro -> 1
  assert.equal(fmtUnits(430_201_920n, 7), '43.020192');
  assert.equal(fmtUnits(-5n, 7), '-0.0000005');
  assert.equal(fmtUsd(257_128n), '0.257128');
});

test('lots: FIFO consumes oldest first and splits basis exactly', () => {
  const b = new LotBook('FIFO');
  b.acquire('X', 100n, 1000n, '2025-01-01T00:00:00Z', 't');
  b.acquire('X', 100n, 3000n, '2025-06-01T00:00:00Z', 't');
  const { disposals, shortfall } = b.dispose('X', 150n, 6000n, '2026-03-01T00:00:00Z');
  assert.equal(shortfall, 0n);
  assert.equal(disposals.length, 2);
  assert.equal(disposals[0]!.basisMicro, 1000n);
  assert.equal(disposals[1]!.basisMicro, 1500n); // half of the second lot
  assert.equal(disposals.reduce((s, d) => s + d.proceedsMicro, 0n), 6000n); // proceeds fully allocated
  assert.equal(disposals[0]!.longTerm, true); // held > 365 days
  assert.equal(disposals[1]!.longTerm, false);
  assert.equal(b.balance('X'), 50n);
});

test('lots: LIFO and HIFO choose differently; shortfall is reported, not hidden', () => {
  const mk = (m: 'LIFO' | 'HIFO'): LotBook => {
    const b = new LotBook(m);
    b.acquire('X', 10n, 100n, '2025-01-01T00:00:00Z', 't'); // $10/unit
    b.acquire('X', 10n, 500n, '2025-02-01T00:00:00Z', 't'); // $50/unit
    b.acquire('X', 10n, 200n, '2025-03-01T00:00:00Z', 't'); // $20/unit
    return b;
  };
  assert.equal(mk('LIFO').dispose('X', 10n, 0n, '2025-04-01T00:00:00Z').disposals[0]!.basisMicro, 200n);
  assert.equal(mk('HIFO').dispose('X', 10n, 0n, '2025-04-01T00:00:00Z').disposals[0]!.basisMicro, 500n);
  const b = new LotBook();
  b.acquire('X', 5n, 50n, '2025-01-01T00:00:00Z', 't');
  assert.equal(b.dispose('X', 8n, 80n, '2025-02-01T00:00:00Z').shortfall, 3n);
});

test('positions: withdrawing part of the shares releases proportional principal and the rest is interest', () => {
  const p = new Positions();
  const key = Positions.key('blend', 'POOL', 'USDC');
  p.deposit(key, 1000n, 1100n, [{ asset: 'USDC', units: 1100n, basisMicro: 1_100_000n, acquiredAt: '2025-01-01T00:00:00Z' }]);
  const r = p.withdraw(key, 500n, 600n); // half the shares, receives 600 for 550 principal
  assert.equal(r.principalUnits, 550n);
  assert.equal(r.interestUnits, 50n);
  assert.equal(r.unknownUnits, 0n);
  assert.equal(r.carries.reduce((s, c) => s + c.units, 0n), 550n);
  assert.equal(r.carries.reduce((s, c) => s + c.basisMicro, 0n), 550_000n);
  assert.equal(p.snapshot()[0]!.shares, 500n);
});

test('positions: shares deposited before the sync window are flagged, never counted as interest', () => {
  const p = new Positions();
  const r = p.withdraw(Positions.key('blend', 'POOL', 'USDC'), 100n, 120n);
  assert.equal(r.interestUnits, 0n);
  assert.equal(r.unknownUnits, 120n);
  assert.equal(r.shareShortfall, 100n);
});

test('engine: a trade realises the gain between basis and fair value', async () => {
  const e = new Engine(fixedPrices);
  // acquire 100 XLM at $0.10 (basis $10), then trade 50 XLM ($10 at $0.20) for 10 USDC
  e.book.acquire('native', 1_000_000_000n, 10_000_000n, '2025-01-01T00:00:00Z', 'transfer_in');
  await e.apply({
    id: 'a:0', txHash: 'a', ledger: 1, txOrder: 0, closedAt: '2025-02-01T00:00:00Z', kind: 'trade', protocol: 'x',
    counterparty: null, note: '', confidence: 'exact',
    legs: [
      { direction: 'out', asset: 'native', amount: 500_000_000n, decimals: 7 },
      { direction: 'in', asset: USDC, amount: 100_000_000n, decimals: 7 },
    ],
  });
  const r = e.result();
  assert.equal(r.disposals.length, 1);
  assert.equal(r.disposals[0]!.proceedsMicro, 10_000_000n); // $10
  assert.equal(r.disposals[0]!.basisMicro, 5_000_000n); // half of $10
  assert.equal(r.disposals[0]!.gainMicro, 5_000_000n); // $5 gain
  assert.equal(e.book.balance(USDC), 100_000_000n);
  assert.equal(e.book.openLots(USDC)[0]!.basisMicro, 10_000_000n); // received at fair value
});

test('end to end: Blend round trip recognises interest and conserves principal', async () => {
  const { events, result } = await buildLedger(new Map([[BLEND_USER, loadFixture('blend-roundtrip')]]), fixedPrices);
  const supplied = events.filter((e) => e.kind === 'lend_supply').reduce((s, e) => s + e.legs[0]!.amount, 0n);
  const withdrawn = events.filter((e) => e.kind === 'lend_withdraw').reduce((s, e) => s + e.legs[0]!.amount, 0n);
  const interest = result.income.filter((i) => i.kind === 'interest').reduce((s, i) => s + i.units, 0n);
  const openPrincipal = result.positions.reduce((s, p) => s + p.principalUnits, 0n);
  // tokens in = tokens out (withdrawn principal + interest) + principal still in the pool
  assert.equal(supplied + 0n, withdrawn - interest + openPrincipal);
  assert.ok(interest > 0n, 'supply->withdraw at a rising b-rate must produce positive interest');
  assert.equal(result.disposals.length, 0, 'lending is non-taxable carryover: no disposals from a USDC round trip');
  // the first supply funds from USDC the ledger never saw arrive: reported, not hidden
  assert.ok(result.warnings.some((w) => w.code === 'no_lots'));
});

test('end to end: Soroswap swap books a disposal and a fee expense', async () => {
  const { result } = await buildLedger(new Map([[SWAPPER, loadFixture('soroswap-swap')]]), fixedPrices);
  // the account owns nothing tracked before the swap, so disposals carry a no_lots warning (honest, not hidden)
  assert.ok(result.warnings.some((w) => w.code === 'no_lots'));
  assert.equal(result.expenses.filter((x) => x.kind === 'network_fee').length, 1);
  assert.equal(result.income.length, 0);
  assert.equal(result.openBalances.find((b) => b.asset === BLND)?.units, 430_201_920n);
});

test('chronology orders by ledger, then tx order, then event sequence', () => {
  const mk = (ledger: number, txOrder: number, seq: number) => ({ ledger, txOrder, id: `h:${seq}` }) as never;
  const sorted = [mk(2, 0, 0), mk(1, 5, 1), mk(1, 5, 0), mk(1, 2, 9)].sort(byChronology) as { ledger: number; txOrder: number; id: string }[];
  assert.deepEqual(sorted.map((x) => `${x.ledger}/${x.txOrder}/${x.id}`), ['1/2/h:9', '1/5/h:0', '1/5/h:1', '2/0/h:0']);
});
