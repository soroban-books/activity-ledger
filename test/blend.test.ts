import test from 'node:test';
import assert from 'node:assert/strict';
import type { RawEvent, RawTx } from '../src/types.ts';
import { AssetRegistry } from '../src/assets.ts';
import { classifyTx } from '../src/classify/index.ts';
import { buildLedger } from '../src/pipeline.ts';
import { BlendDirectory, candidateContracts, resolveBlend, type VerdictCache } from '../src/blend/directory.ts';
import { factoryKey } from '../src/blend/factory.ts';
import { loadFixture, fixedPrices, USDC } from './helpers.ts';

const POOL = 'CAJJZSGMMM3PD7N33TAPHGBUGTB43OC73HVIK2L2G6BNGGGYOSSYBXBD'; // FixedV2 (seeded)
const POOL2 = 'CCCCIQSDILITHMM7PBSLVDT5MISSY7R26MNZXCX4H7J5JQ5FPIYOGYFS'; // YieldBloxV2 (seeded)
const BACKSTOP = 'CAQQR5SWBXKIGZKPBZDH3KM5GQ5GUTPKB7JAFCINLZBC5WXPJKRG3IM7';
const LP = 'CAS3FL6TLZKDGGSISDBWGGPXT3NRR4DYTZD7YOD3HMYO6LTJUVGRVEAM'; // comet BLND:USDC LP (SEP-41, unpriced)
const USDC_SAC = 'CCW67TSZV3SSS2HXMBQ5JFGCKJNXKZM7UQUWUZPUTHXSTZLEO7SJMI75';
const USER = 'GBJMQBKQL6FQ6BFZ52YJGY6SEMEER3DSTICPIYBZR3P4T2FUDYZEHUN7';
const OTHER = 'GAB6HYBE6DZ2ZIDAXVQSJKUQJBEIAYHXTBLUTDQJLKI6S6WJWJ7TMGF5';
const VICTIM = 'GAB6HYBE6DZ2ZIDAXVQSJKUQJBEIAYHXTBLUTDQJLKI6S6WJWJ7TMGF5';
const LIQUIDATOR = 'GDBVQFIGDHRBAP4H5RM72T4BUXMACKQ4LS7NZABPWHI36BLZXHATJJIR';
const LOOKALIKE = 'CBAKAZUEJBAFA2DCGBRS2WKJT3FNIMJBHTFL76AY7XMAVEINQNNIQWAO'; // emitted 170 Blend-shaped flash_loan events, not a pool

// ---- synthetic transaction builder (events follow the contract source, not guesses) -----------
let seq = 0;
const ev = (contractId: string, topics: unknown[], data: unknown): RawEvent => ({
  ledger: 1, txHash: 'x', opIndex: 0, eventIndex: seq++, contractId, type: 'contract', topics, data,
});
const transfer = (from: string, to: string, amount: bigint, asset = USDC): RawEvent => ev(USDC_SAC, ['transfer', from, to, asset], amount);
const lpTransfer = (from: string, to: string, amount: bigint): RawEvent => ev(LP, ['transfer', from, to], amount);
let ledgerNo = 100;
function mk(events: RawEvent[], opts: { source?: string; at?: string; ok?: boolean } = {}): RawTx {
  const n = ledgerNo++;
  return {
    ledger: n, closedAt: opts.at ?? `2026-0${1 + (n % 9)}-10T00:00:00Z`, hash: `h${n}`.padEnd(64, '0'), applicationOrder: 0,
    sourceAccount: opts.source ?? USER, feeAccount: opts.source ?? USER, successful: opts.ok ?? true,
    feeCharged: 0n, opTypes: ['invokeHostFunction'], invokedContracts: [POOL], invokedFunctions: ['submit'],
    events: events.map((e, i) => ({ ...e, ledger: n, eventIndex: i, txHash: `h${n}` })),
  };
}
const classify = (tx: RawTx, account = USER, dir = BlendDirectory.seeded()) => classifyTx(tx, account, new AssetRegistry(), dir);

// ---- pool verification -----------------------------------------------------------------------
test('verification: Blend-shaped events from an unverified contract are NOT decoded as Blend', () => {
  const tx = mk([
    ev(LOOKALIKE, ['supply', USDC_SAC, USER], [1000n, 900n]),
    transfer(USER, LOOKALIKE, 1000n),
  ]);
  const evs = classify(tx);
  assert.ok(evs.every((e) => e.protocol !== 'blend'), 'must fall through to the generic path');
  assert.equal(evs.find((e) => e.kind === 'lend_supply'), undefined);
  // and the same events from a verified pool are decoded exactly
  const real = classify(mk([ev(POOL, ['supply', USDC_SAC, USER], [1000n, 900n]), transfer(USER, POOL, 1000n)]));
  assert.equal(real[0]!.kind, 'lend_supply');
  assert.equal(real[0]!.protocol, 'blend');
});

test('verification: resolveBlend accepts factory pools, rejects others, caches, and never caches failures', async () => {
  const store = new Map<string, { verdict: 'pool' | 'no'; checkedAt: string }>();
  const cache: VerdictCache = {
    blendVerdict: (c) => store.get(c),
    setBlendVerdict: (c, v) => void store.set(c, { verdict: v, checkedAt: new Date(NOW).toISOString() }),
  };
  const NOW = Date.parse('2026-11-05T00:00:00Z');
  const NEW_POOL = 'CDQ2OSPIEAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA';
  const calls: string[] = [];
  const lookup = async (id: string): Promise<boolean> => {
    calls.push(id);
    if (id === 'BOOM') throw new Error('rpc down');
    return id === NEW_POOL;
  };
  const dir = BlendDirectory.seeded();
  await resolveBlend(dir, [NEW_POOL, LOOKALIKE, 'BOOM'], { cache, lookup, now: NOW });
  assert.ok(dir.isPool(NEW_POOL));
  assert.ok(dir.rejected.has(LOOKALIKE) && !dir.isPool(LOOKALIKE));
  assert.ok(dir.unverified.has('BOOM'));
  assert.equal(store.has('BOOM'), false, 'a failed lookup must not be cached as a verdict');
  // second run: positives and fresh negatives come from the cache, the failure is retried
  calls.length = 0;
  const dir2 = BlendDirectory.seeded();
  await resolveBlend(dir2, [NEW_POOL, LOOKALIKE, 'BOOM'], { cache, lookup, now: NOW + 3_600_000 });
  assert.deepEqual(calls, ['BOOM']);
  // a negative verdict older than a day is re-checked
  calls.length = 0;
  await resolveBlend(BlendDirectory.seeded(), [LOOKALIKE], { cache, lookup, now: NOW + 2 * 86_400_000 });
  assert.deepEqual(calls, [LOOKALIKE]);
});

test('verification: candidates are only contracts that emit Blend-shaped events and are not yet known', () => {
  const dir = BlendDirectory.seeded();
  const txs = [mk([ev(LOOKALIKE, ['borrow', USDC_SAC, USER], [1n, 1n]), ev(POOL, ['supply', USDC_SAC, USER], [1n, 1n]), transfer(USER, POOL, 1n)])];
  assert.deepEqual([...candidateContracts(txs, dir)], [LOOKALIKE]);
});

test('verification: factory storage key is Vec[Symbol(Contracts), Address] under the factory, persistent', () => {
  // sdk 17 decodes XDR unions to { type, <arm> } objects, so arms are properties.
  const nm = (x: any): string => (typeof x === 'string' ? x : x?.name);
  const key = factoryKey('CDSYOAVXFY7SM5S64IZPPPYB4GVGGLMQVFREPSQQEZVIWXX5R23G4QSU', POOL) as any;
  assert.equal(nm(key.type), 'contractData');
  const cd = key.contractData;
  assert.equal(nm(cd.durability), 'persistent');
  assert.equal(nm(cd.key.type), 'scvVec');
  const vec = cd.key.vec;
  assert.equal(vec.length, 2);
  assert.equal(String(vec[0].sym), 'Contracts');
  assert.equal(nm(vec[1].type), 'scvAddress');
});

// ---- ownership: from is the position owner, not necessarily the payer ------------------------
test('on-behalf: a supply for this account paid by someone else books no wallet movement', () => {
  const tx = mk([ev(POOL, ['supply', USDC_SAC, USER], [1000n, 900n]), transfer(OTHER, POOL, 1000n)], { source: OTHER });
  const evs = classify(tx, USER);
  assert.equal(evs.length, 1);
  assert.equal(evs[0]!.kind, 'unclassified');
  assert.deepEqual(evs[0]!.legs, []);
  assert.match(evs[0]!.note, /moved between other addresses/);
});

test('on-behalf: a withdraw delivered to another address books no wallet inflow', () => {
  const tx = mk([ev(POOL, ['withdraw', USDC_SAC, USER], [1000n, 900n]), transfer(POOL, OTHER, 1000n)]);
  const evs = classify(tx, USER);
  assert.equal(evs.find((e) => e.kind === 'lend_withdraw'), undefined);
  assert.equal(evs.find((e) => e.legs.some((l) => l.direction === 'in')), undefined);
});

// ---- borrow / repay with d-token shares ------------------------------------------------------
test('debt: repay interest is proportional to burnt d-tokens, not principal-first', async () => {
  const txs = [
    mk([ev(POOL, ['borrow', USDC_SAC, USER], [1000n, 1000n]), transfer(POOL, USER, 1000n)]),
    // pay 550 for 500 of the 1000 d-tokens: 500 principal + 50 interest
    mk([ev(POOL, ['repay', USDC_SAC, USER], [550n, 500n]), transfer(USER, POOL, 550n)]),
    // pay the rest: 500 d-tokens for 600 tokens: 500 principal + 100 interest
    mk([ev(POOL, ['repay', USDC_SAC, USER], [600n, 500n]), transfer(USER, POOL, 600n)]),
  ];
  const { result } = await buildLedger(new Map([[USER, txs]]), fixedPrices);
  const interest = result.expenses.filter((x) => x.kind === 'borrow_interest').map((x) => x.units);
  assert.deepEqual(interest, [50n, 100n]);
  assert.deepEqual(result.debts, []);
  assert.equal(result.warnings.filter((w) => w.code === 'unknown_debt').length, 0);
});

test('debt: a partial repay books interest in proportion (50 of 550), where the old principal-first model booked 0', async () => {
  // Same economic total over the loan's life, different timing. Pinned so the per-share model cannot regress silently.
  const txs = [
    mk([ev(POOL, ['borrow', USDC_SAC, USER], [1000n, 1000n]), transfer(POOL, USER, 1000n)]),
    mk([ev(POOL, ['repay', USDC_SAC, USER], [550n, 500n]), transfer(USER, POOL, 550n)]),
  ];
  const { result } = await buildLedger(new Map([[USER, txs]]), fixedPrices);
  assert.equal(result.expenses.filter((x) => x.kind === 'borrow_interest').reduce((s, x) => s + x.units, 0n), 50n);
  assert.equal(result.debts[0]!.principalUnits, 500n);
  assert.equal(result.debts[0]!.shares, 500n);
});

test('debt: debts in different pools do not mix', async () => {
  const txs = [
    mk([ev(POOL, ['borrow', USDC_SAC, USER], [1000n, 1000n]), transfer(POOL, USER, 1000n)]),
    mk([ev(POOL2, ['borrow', USDC_SAC, USER], [100n, 100n]), transfer(POOL2, USER, 100n)]),
    mk([ev(POOL2, ['repay', USDC_SAC, USER], [110n, 100n]), transfer(USER, POOL2, 110n)]),
  ];
  const { result } = await buildLedger(new Map([[USER, txs]]), fixedPrices);
  assert.equal(result.expenses.filter((x) => x.kind === 'borrow_interest').reduce((s, x) => s + x.units, 0n), 10n);
  assert.equal(result.debts.length, 1);
  assert.equal(result.debts[0]!.principalUnits, 1000n);
});

test('debt: a repay with no tracked borrow books the disposal but no invented interest, and warns', async () => {
  const txs = [mk([ev(POOL, ['repay', USDC_SAC, USER], [700n, 600n]), transfer(USER, POOL, 700n)])];
  const { result } = await buildLedger(new Map([[USER, txs]]), fixedPrices);
  assert.equal(result.expenses.filter((x) => x.kind === 'borrow_interest').length, 0);
  assert.equal(result.warnings.filter((w) => w.code === 'unknown_debt').length, 1);
});

test('flash loan: debt is tracked, no cash arrives in the wallet', async () => {
  const RECEIVER = 'CBLJ6FNASZ2WMYZA3CJFGVUJRBMNAPGXRYJH4JBBI55VCPP3MREH3TFG';
  const tx = mk([ev(POOL, ['flash_loan', USDC_SAC, USER, RECEIVER], [5000n, 4800n]), transfer(POOL, RECEIVER, 5000n)]);
  const evs = classify(tx);
  assert.equal(evs[0]!.kind, 'borrow');
  assert.deepEqual(evs[0]!.legs, []);
  assert.equal(evs[0]!.position!.protocol, 'blend-debt');
  assert.equal(evs[0]!.position!.tokens, 5000n);
  const { result } = await buildLedger(new Map([[USER, [tx]]]), fixedPrices);
  assert.deepEqual(result.openBalances, []);
  assert.equal(result.debts[0]!.shares, 4800n);
});

// ---- backstop --------------------------------------------------------------------------------
test('backstop: deposit then withdraw realises LP-token interest from the share ledger', async () => {
  const txs = [
    mk([ev(BACKSTOP, ['deposit', POOL, USER], [1000n, 900n]), lpTransfer(USER, BACKSTOP, 1000n)]),
    mk([ev(BACKSTOP, ['withdraw', POOL, USER], [900n, 1100n]), lpTransfer(BACKSTOP, USER, 1100n)]),
  ];
  // The user must hold the LP tokens first so the supply is not "no lots".
  const seed = mk([lpTransfer(OTHER, USER, 1000n)], { at: '2026-01-01T00:00:00Z' });
  seed.ledger = 50;
  const evs = [seed, ...txs].flatMap((t) => classify(t));
  const dep = evs.find((e) => e.kind === 'lend_supply')!;
  assert.equal(dep.position!.protocol, 'blend-backstop');
  assert.equal(dep.position!.pool, POOL);
  assert.equal(dep.position!.shares, 900n);
  const wd = evs.find((e) => e.kind === 'lend_withdraw')!;
  assert.equal(wd.position!.shares, 900n, 'backstop withdraw data is [shares, tokens_out]: shares come first');
  assert.equal(wd.legs[0]!.amount, 1100n);
  const { result } = await buildLedger(new Map([[USER, [seed, ...txs]]]), fixedPrices);
  const interest = result.income.filter((i) => i.kind === 'interest');
  assert.equal(interest.length, 1);
  assert.equal(interest[0]!.units, 100n);
  assert.equal(result.positions.length, 0);
});

test('backstop: queue and dequeue are notices, claim is a reward, none are flagged unclassified', () => {
  const q = classify(mk([ev(BACKSTOP, ['queue_withdrawal', POOL, USER], [900n, 1_800_000_000n])]));
  assert.equal(q[0]!.kind, 'no_op');
  assert.match(q[0]!.note, /queued: 900 shares, claimable after 2027-01-15/);
  const dq = classify(mk([ev(BACKSTOP, ['dequeue_withdrawal', POOL, USER], 900n)]));
  assert.equal(dq[0]!.kind, 'no_op');
  const claim = classify(mk([ev(BACKSTOP, ['claim', USER], 777n), ev(LP, ['mint', USER], 777n)]));
  assert.equal(claim[0]!.kind, 'reward_claim');
  assert.equal(claim[0]!.legs[0]!.amount, 777n);
  assert.equal(claim[0]!.legs[0]!.asset, LP);
});

test('backstop: events from a contract that is not a known backstop are ignored', () => {
  const evs = classify(mk([ev(LOOKALIKE, ['deposit', POOL, USER], [1000n, 900n]), lpTransfer(USER, LOOKALIKE, 1000n)]));
  assert.equal(evs.find((e) => e.kind === 'lend_supply'), undefined);
});

// ---- auctions and liquidations (real mainnet fixture, ledgers 65204073-65204444) -----------
const liq = loadFixture('blend-liquidation');

test('liquidation (real): the liquidated user sees a notice, then two fills that seize collateral and clear debt', async () => {
  const evs = liq.flatMap((tx) => classify(tx, VICTIM));
  const kinds = evs.filter((e) => e.kind !== 'fee').map((e) => e.kind);
  assert.deepEqual(kinds, ['no_op', 'liquidation', 'liquidation']);
  const first = evs.find((e) => e.kind === 'liquidation')!;
  assert.ok(first.positions!.length >= 2);
  assert.ok(first.positions!.every((p) => p.direction === 'out'));
  assert.ok(first.positions!.some((p) => p.protocol === 'blend-debt'));
  assert.ok(first.positions!.some((p) => p.protocol === 'blend'));
  // exact amounts from the auction data of the first fill (60%)
  const bidUsdc = first.positions!.find((p) => p.protocol === 'blend-debt' && p.asset.startsWith('USDC'))!;
  assert.equal(bidUsdc.shares, 10288526051n);
  const { result } = await buildLedger(new Map([[VICTIM, liq]]), fixedPrices);
  assert.equal(result.warnings.filter((w) => w.code === 'liquidation_unvalued').length, 2);
  assert.equal(result.disposals.length, 0, 'no gain or loss may be invented without pool rates');
});

test('liquidation (real): a G-account liquidator decodes the fill and its repay exactly, and flags what it cannot value', async () => {
  const evs = liq.flatMap((tx) => classify(tx, LIQUIDATOR));
  const fills = evs.filter((e) => e.kind === 'liquidation');
  assert.equal(fills.length, 2);
  assert.ok(fills.every((f) => f.positions!.every((p) => p.direction === 'in')));
  const repay = evs.find((e) => e.kind === 'repay')!;
  assert.equal(repay.legs[0]!.amount, 3632079n);
  assert.equal(repay.position!.shares, 2906551n);
  const { result } = await buildLedger(new Map([[LIQUIDATOR, liq]]), fixedPrices);
  const codes = result.warnings.map((w) => w.code);
  assert.ok(codes.includes('liquidation_unvalued'));
  assert.ok(codes.includes('unknown_debt'), 'debt assumed in the fill is not tracked, so its repay cannot be split into interest');
  assert.equal(result.expenses.filter((x) => x.kind === 'borrow_interest').length, 0);
});

test('liquidation: a user who is neither victim nor filler is not involved', () => {
  const evs = liq.flatMap((tx) => classify(tx, USER));
  assert.deepEqual(evs.filter((e) => e.protocol === 'blend'), []);
});

test('bad debt: written-off d-tokens clear the tracked debt and warn', async () => {
  const txs = [
    mk([ev(POOL, ['borrow', USDC_SAC, USER], [1000n, 1000n]), transfer(POOL, USER, 1000n)]),
    mk([ev(POOL, ['bad_debt', USER, USDC_SAC], 600n)]),
  ];
  const { events, result } = await buildLedger(new Map([[USER, txs]]), fixedPrices);
  assert.ok(events.some((e) => e.kind === 'liquidation'));
  assert.equal(result.debts[0]!.shares, 400n);
  assert.equal(result.warnings.filter((w) => w.code === 'liquidation_unvalued').length, 1);
});

// ---- maintenance calls and robustness --------------------------------------------------------
test('maintenance: calling gulp on a pool is a notice, not an unclassified contract call', () => {
  const evs = classify(mk([ev(POOL, ['gulp', USDC_SAC], 5n)]));
  assert.deepEqual(evs.map((e) => e.kind), ['no_op']);
});

test('robustness: malformed Blend events never throw and never invent movements', () => {
  const bad = [
    ev(POOL, ['supply', USDC_SAC, USER], 'nonsense'),
    ev(POOL, ['supply', USDC_SAC, USER], [1000n]),
    ev(POOL, ['borrow', 42, USER], [1n, 1n]),
    ev(POOL, ['fill_auction', 0, VICTIM], ['x']),
    ev(POOL, ['fill_auction', 0, USER], [USER, 5n, { bid: { a: 'not a bigint' }, lot: {} }]),
    ev(BACKSTOP, ['withdraw', POOL, USER], [null, undefined]),
    ev(POOL, [], null),
  ];
  const evs = classify(mk(bad));
  assert.equal(evs.filter((e) => e.kind === 'lend_supply' || e.kind === 'liquidation' || e.kind === 'borrow').length, 0);
});

test('failed transactions are never decoded as Blend activity', () => {
  const evs = classify(mk([ev(POOL, ['supply', USDC_SAC, USER], [1000n, 900n]), transfer(USER, POOL, 1000n)], { ok: false }));
  assert.equal(evs.find((e) => e.protocol === 'blend'), undefined);
});

test('pipeline: unverified contracts are reported, not silently dropped', async () => {
  const dir = BlendDirectory.seeded();
  dir.unverified.add(LOOKALIKE);
  const tx = mk([ev(LOOKALIKE, ['supply', USDC_SAC, USER], [1000n, 900n]), transfer(USER, LOOKALIKE, 1000n)]);
  const { result } = await buildLedger(new Map([[USER, [tx]]]), fixedPrices, {}, dir);
  assert.ok(result.warnings.some((w) => /could not be verified as a Blend pool/.test(w.message)));
});
