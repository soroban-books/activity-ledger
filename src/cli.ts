#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { StrKey } from '@stellar/stellar-sdk';
import { Store } from './store.ts';
import { syncAccount } from './sync.ts';
import { buildLedger } from './pipeline.ts';
import { CompositeProvider, ManualProvider, PegProvider, SdexProvider } from './pricing/providers.ts';
import { koinlyCsv } from './export/koinly.ts';
import { eventsCsv, gainsCsv, incomeCsv, journalCsv } from './export/reports.ts';
import { summary } from './report.ts';
import { stringifyFixture } from './util.ts';
import type { LotMethod } from './ledger/lots.ts';

const USAGE = `activity-ledger <command> <G-address...> [options]
  sync     fetch and store transactions     --db file  --limit n
  report   classified summary               --year Y  --method FIFO|LIFO|HIFO  --lp disposal|carryover  --prices manual.csv
  events   print classified events
  export   write files                      --format koinly|events|gains|income|journal|json|all  --out dir
  serve    web UI on localhost (no address)  --port 4173  --prices manual.csv
Options: --db ledger.sqlite (default)`;

function parse(argv: string[]): { cmd: string; accounts: string[]; opts: Record<string, string> } {
  const [cmd = '', ...rest] = argv;
  const accounts: string[] = [];
  const opts: Record<string, string> = {};
  for (let i = 0; i < rest.length; i++) {
    const a = rest[i]!;
    if (a.startsWith('--')) opts[a.slice(2)] = rest[++i] ?? '';
    else accounts.push(a);
  }
  return { cmd, accounts, opts };
}

async function main(): Promise<void> {
  const { cmd, accounts, opts } = parse(process.argv.slice(2));
  if (cmd === 'serve') {
    const { startServer } = await import('./server.ts');
    const port = opts.port ? Number(opts.port) : 4173;
    if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('--port must be 1-65535');
    await startServer({ db: opts.db ?? 'ledger.sqlite', port, manualPrices: opts.prices });
    console.log(`activity-ledger running at http://localhost:${port}  (Ctrl+C to stop)`);
    return;
  }
  if (!cmd || accounts.length === 0) {
    console.log(USAGE);
    process.exit(cmd ? 1 : 0);
  }
  for (const a of accounts) if (!StrKey.isValidEd25519PublicKey(a)) throw new Error(`invalid G... address: ${a}`);
  const store = new Store(opts.db ?? 'ledger.sqlite');

  if (cmd === 'sync') {
    for (const account of accounts) {
      const before = store.txs(account).length;
      const r = await syncAccount(account, {
        cursor: store.cursor(account),
        limit: opts.limit ? Number(opts.limit) : undefined,
        onSkip: (h, why) => store.skip(account, h.hash, h.ledger, why),
        onTx: (tx, token) => {
          store.putTx(account, tx);
          store.setCursor(account, token);
        },
      });
      console.log(`${account}: +${r.txs} txs (total ${before + r.txs}), skipped ${r.skipped}`);
      for (const s of store.skipped(account).slice(0, 5)) console.log(`  skipped ${s.hash.slice(0, 10)} @${s.ledger}: ${s.reason}`);
    }
    return;
  }

  const per = new Map(accounts.map((a) => [a, store.txs(a)] as const));
  const prices = new CompositeProvider([new ManualProvider(opts.prices), new PegProvider(), new SdexProvider()]);
  const { events, result } = await buildLedger(per, prices, {
    lotMethod: (opts.method as LotMethod) ?? 'FIFO',
    lp: (opts.lp as 'disposal' | 'carryover') ?? 'disposal',
  });

  if (cmd === 'report') console.log(summary(events, result, opts.year ? Number(opts.year) : undefined));
  else if (cmd === 'events') console.log(eventsCsv(events, result));
  else if (cmd === 'export') {
    const out = opts.out ?? 'out';
    fs.mkdirSync(out, { recursive: true });
    const fmt = opts.format ?? 'all';
    const write = (name: string, body: string): void => {
      fs.writeFileSync(path.join(out, name), body);
      console.log('wrote', path.join(out, name));
    };
    if (fmt === 'koinly' || fmt === 'all') write('koinly.csv', koinlyCsv(events, result.pricedLegs, result.income));
    if (fmt === 'events' || fmt === 'all') write('events.csv', eventsCsv(events, result));
    if (fmt === 'gains' || fmt === 'all') write('gains.csv', gainsCsv(result));
    if (fmt === 'income' || fmt === 'all') write('income.csv', incomeCsv(result));
    if (fmt === 'journal' || fmt === 'all') write('journal.csv', journalCsv(result));
    if (fmt === 'json' || fmt === 'all') write('ledger.json', stringifyFixture({ events, warnings: result.warnings, positions: result.positions }));
  } else {
    console.log(USAGE);
    process.exit(1);
  }
  store.close();
}

main().catch((e) => {
  console.error(e instanceof Error ? e.message : e);
  process.exit(1);
});
