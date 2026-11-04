import test from 'node:test';
import assert from 'node:assert/strict';
import { loadFixture, classifyAll, USDC, BLND } from './helpers.ts';

const BLEND_USER = 'GBJMQBKQL6FQ6BFZ52YJGY6SEMEER3DSTICPIYBZR3P4T2FUDYZEHUN7';
const SWAPPER = 'GCOGUAYJVAJN7XJ4PSJ5J6JSB3GW2OHXLUOGHTKQAMXW34A337YJOPIT';
const RECIPIENT = 'GDDIQ77QRV2LAK3I2K6SVB7VGTDOT4WRTUTXOX2TAAS2WVUFDTHILJTD';

test('Blend round trip decodes exactly: supply, withdraw, supply, withdraw', () => {
  const ev = classifyAll(loadFixture('blend-roundtrip'), BLEND_USER).filter((e) => e.kind !== 'fee');
  assert.deepEqual(ev.map((e) => e.kind), ['lend_supply', 'lend_withdraw', 'lend_supply', 'lend_withdraw']);
  assert.ok(ev.every((e) => e.protocol === 'blend' && e.confidence === 'exact'));
  assert.equal(ev[0]!.legs[0]!.amount, 166_900_000n); // 16.69 USDC
  assert.equal(ev[0]!.legs[0]!.asset, USDC); // SAC contract id resolved to the classic asset
  assert.equal(ev[0]!.position!.shares, 144_638_091n);
  assert.equal(ev[1]!.position!.shares, 51_988_912n);
});

test('Blend decoder claims the pool transfer so it is not double counted', () => {
  const ev = classifyAll(loadFixture('blend-roundtrip'), BLEND_USER);
  assert.equal(ev.filter((e) => e.kind === 'transfer_in' || e.kind === 'transfer_out').length, 0);
});

test('Soroswap router swap becomes one exact trade with the right legs, plus a net fee', () => {
  const ev = classifyAll(loadFixture('soroswap-swap'), SWAPPER);
  const trade = ev.find((e) => e.kind === 'trade')!;
  assert.equal(trade.protocol, 'soroswap');
  assert.equal(trade.confidence, 'exact');
  assert.deepEqual(
    trade.legs.map((l) => [l.direction, l.asset, l.amount]),
    [['out', USDC, 2_571_280n], ['in', BLND, 430_201_920n]],
  );
  const fee = ev.find((e) => e.kind === 'fee')!;
  assert.equal(fee.legs[0]!.amount, 43_869n - 10_522n); // charge minus refund
  assert.equal(ev.filter((e) => e.kind === 'transfer_in' || e.kind === 'transfer_out').length, 0);
});

test('generic heuristic classifies the same swap when no protocol decoder applies', () => {
  const txs = loadFixture('soroswap-swap');
  // strip router/pair events so only CAP-67 transfers remain
  for (const tx of txs) tx.events = tx.events.filter((e) => e.topics[0] === 'transfer' || e.topics[0] === 'fee');
  const trade = classifyAll(txs, SWAPPER).find((e) => e.kind === 'trade')!;
  assert.equal(trade.confidence, 'heuristic');
  assert.deepEqual(trade.legs.map((l) => [l.direction, l.asset, l.amount]), [['out', USDC, 2_571_280n], ['in', BLND, 430_201_920n]]);
});

test('classic payment received with a memo id is a transfer_in carrying the memo', () => {
  const ev = classifyAll(loadFixture('classic-multipay'), RECIPIENT);
  assert.equal(ev.length, 1);
  assert.equal(ev[0]!.kind, 'transfer_in');
  assert.equal(ev[0]!.legs[0]!.amount, 127_892_063_046n);
  assert.match(ev[0]!.note, /XTAR\/XLM LP Rewards/);
});

test('an account not involved in a transaction gets no events', () => {
  assert.equal(classifyAll(loadFixture('soroswap-swap'), RECIPIENT).length, 0);
});

test('failed transactions only produce a fee', () => {
  const txs = loadFixture('soroswap-swap');
  txs[0]!.successful = false;
  const ev = classifyAll(txs, SWAPPER);
  assert.deepEqual(ev.map((e) => e.kind), ['fee']);
});

test('a contract call by the account with no asset movement is flagged unclassified', () => {
  const txs = loadFixture('soroswap-swap');
  const tx = txs[0]!;
  tx.events = tx.events.filter((e) => e.topics[0] === 'fee'); // keep only fee events
  const ev = classifyAll([{ ...tx, sourceAccount: SWAPPER, invokedContracts: ['CAG5LRYQ5JVEUI5TEID72EYOVX44TTUJT5BQR2J6J77FH65PCCFAJDDH'], invokedFunctions: ['swap_exact_tokens_for_tokens'] }], SWAPPER);
  assert.deepEqual(ev.map((e) => e.kind).sort(), ['fee', 'unclassified']);
});

test('zero-amount transfers are ignored (no empty events)', () => {
  const txs = loadFixture('classic-multipay');
  const first = txs[0]!.events.find((e) => e.topics[0] === 'transfer')!;
  first.data = { amount: 0n };
  const ev = classifyAll(txs, RECIPIENT);
  assert.equal(ev.length, 0);
});
