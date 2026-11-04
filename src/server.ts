/**
 * Local web server: JSON API + static UI over the same engine the CLI uses.
 * Binds to loopback only, rejects foreign Host headers (DNS rebinding) and requires JSON bodies
 * on POST (so a cross-site form cannot start a sync). Public chain data only; no keys anywhere.
 */
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { StrKey } from '@stellar/stellar-sdk';
import { Store } from './store.ts';
import { syncAccount } from './sync.ts';
import { buildLedger } from './pipeline.ts';
import { reportDto } from './dto.ts';
import { CompositeProvider, ManualProvider, PegProvider, SdexProvider } from './pricing/providers.ts';
import { koinlyCsv } from './export/koinly.ts';
import { eventsCsv, gainsCsv, incomeCsv, journalCsv } from './export/reports.ts';
import { stringifyFixture } from './util.ts';
import type { LotMethod } from './ledger/lots.ts';
import type { PriceProvider } from './pricing/types.ts';

export interface ServeOptions {
  db: string;
  port: number;
  host?: string;
  webDir?: string;
  manualPrices?: string;
  /** Override the price source (tests use a fixed one so nothing touches the network). */
  prices?: PriceProvider;
}

interface Progress {
  account: string;
  txs: number;
  skipped: number;
  state: 'waiting' | 'running' | 'done' | 'error';
  error?: string;
}
interface Job {
  id: string;
  limit?: number;
  status: 'running' | 'done' | 'error';
  progress: Progress[];
  startedAt: string;
  subs: Set<http.ServerResponse>;
}

const TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.txt': 'text/plain; charset=utf-8',
  '.woff2': 'font/woff2',
};

class HttpError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

const json = (res: http.ServerResponse, status: number, body: unknown): void => {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
  res.end(JSON.stringify(body));
};

function parseAccounts(raw: string | null | undefined): string[] {
  const list = [...new Set((raw ?? '').split(/[\s,]+/).filter(Boolean))];
  if (list.length === 0) throw new HttpError(400, 'Enter at least one Stellar address (starts with G).');
  if (list.length > 10) throw new HttpError(400, 'At most 10 addresses at a time.');
  for (const a of list) if (!StrKey.isValidEd25519PublicKey(a)) throw new HttpError(400, `Not a valid Stellar address: ${a}`);
  return list;
}

async function readJson(req: http.IncomingMessage): Promise<Record<string, unknown>> {
  if (!(req.headers['content-type'] ?? '').startsWith('application/json')) throw new HttpError(415, 'Send JSON.');
  let size = 0;
  const chunks: Buffer[] = [];
  for await (const c of req) {
    size += (c as Buffer).length;
    if (size > 16_384) throw new HttpError(413, 'Request too large.');
    chunks.push(c as Buffer);
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8')) as Record<string, unknown>;
  } catch {
    throw new HttpError(400, 'Invalid JSON.');
  }
}

export function startServer(opts: ServeOptions): Promise<http.Server> {
  const host = opts.host ?? '127.0.0.1';
  const webDir = path.resolve(opts.webDir ?? fileURLToPath(new URL('../web/', import.meta.url)));
  const store = new Store(opts.db);
  const jobs = new Map<string, Job>();
  const allowedHosts = new Set([`localhost:${opts.port}`, `127.0.0.1:${opts.port}`, `[::1]:${opts.port}`]);
  const ledgerCache = new Map<string, Awaited<ReturnType<typeof buildLedger>>>();

  const provider = (): PriceProvider => opts.prices ?? new CompositeProvider([new ManualProvider(opts.manualPrices), new PegProvider(), new SdexProvider()]);

  async function ledgerFor(q: URLSearchParams) {
    const accounts = parseAccounts(q.get('accounts'));
    const method = (q.get('method') ?? 'FIFO').toUpperCase();
    if (!['FIFO', 'LIFO', 'HIFO'].includes(method)) throw new HttpError(400, 'method must be FIFO, LIFO or HIFO.');
    const lp = q.get('lp') ?? 'disposal';
    if (!['disposal', 'carryover'].includes(lp)) throw new HttpError(400, 'lp must be disposal or carryover.');
    const per = new Map(accounts.map((a) => [a, store.txs(a)] as const));
    const key = [...per].map(([a, t]) => `${a}:${t.length}`).sort().join(',') + `|${method}|${lp}`;
    let built = ledgerCache.get(key);
    if (!built) {
      built = await buildLedger(per, provider(), { lotMethod: method as LotMethod, lp: lp as 'disposal' | 'carryover' });
      if (ledgerCache.size >= 8) ledgerCache.delete(ledgerCache.keys().next().value as string);
      ledgerCache.set(key, built);
    }
    return { accounts, built };
  }

  /** Horizon's history window slides forward continuously; report where it starts right now. */
  let metaCache: { at: number; value: { earliest: string | null; ledger: number | null } } | null = null;
  async function horizonMeta(): Promise<{ earliest: string | null; ledger: number | null }> {
    if (metaCache && Date.now() - metaCache.at < 600_000) return metaCache.value;
    let value: { earliest: string | null; ledger: number | null } = { earliest: null, ledger: null };
    try {
      const root = (await (await fetch('https://horizon.stellar.org/', { signal: AbortSignal.timeout(15_000) })).json()) as { history_elder_ledger?: number };
      const ledger = root.history_elder_ledger ?? null;
      if (ledger) {
        const l = (await (await fetch(`https://horizon.stellar.org/ledgers/${ledger}`, { signal: AbortSignal.timeout(15_000) })).json()) as { closed_at?: string };
        value = { earliest: l.closed_at ?? null, ledger };
      }
    } catch {
      /* offline or slow: the UI falls back to generic wording */
    }
    if (value.earliest) metaCache = { at: Date.now(), value };
    return value;
  }

  const publish = (job: Job): void => {
    const payload = `data: ${JSON.stringify({ id: job.id, status: job.status, progress: job.progress })}\n\n`;
    for (const r of job.subs) r.write(payload);
  };

  async function runJob(job: Job): Promise<void> {
    let lastPush = 0;
    try {
      for (const p of job.progress) {
        p.state = 'running';
        publish(job);
        try {
          const r = await syncAccount(p.account, {
            cursor: store.cursor(p.account),
            limit: job.limit,
            onSkip: (h, why) => {
              store.skip(p.account, h.hash, h.ledger, why);
              p.skipped++;
            },
            onTx: (tx, token) => {
              store.putTx(p.account, tx);
              store.setCursor(p.account, token);
              p.txs++;
              if (Date.now() - lastPush > 300) {
                lastPush = Date.now();
                publish(job);
              }
            },
          });
          p.txs = r.txs;
          p.skipped = r.skipped;
          p.state = 'done';
        } catch (e) {
          p.state = 'error';
          p.error = e instanceof Error ? e.message : String(e);
        }
        publish(job);
      }
      job.status = job.progress.some((p) => p.state === 'error') ? 'error' : 'done';
    } finally {
      ledgerCache.clear();
      publish(job);
      for (const r of job.subs) r.end();
      job.subs.clear();
    }
  }

  async function api(req: http.IncomingMessage, res: http.ServerResponse, url: URL): Promise<void> {
    const route = `${req.method} ${url.pathname}`;

    if (route === 'GET /api/meta') return json(res, 200, await horizonMeta());

    if (route === 'GET /api/accounts') return json(res, 200, { accounts: store.accounts() });

    if (route === 'POST /api/sync') {
      if ([...jobs.values()].some((j) => j.status === 'running')) throw new HttpError(409, 'A sync is already running. Wait for it to finish.');
      const body = await readJson(req);
      const accounts = parseAccounts(Array.isArray(body.accounts) ? body.accounts.join(' ') : String(body.accounts ?? ''));
      const limit = body.limit === undefined || body.limit === null || body.limit === '' ? undefined : Number(body.limit);
      if (limit !== undefined && (!Number.isInteger(limit) || limit < 1 || limit > 100_000)) throw new HttpError(400, 'limit must be a whole number from 1 to 100000.');
      const job: Job = {
        id: randomUUID(),
        limit,
        status: 'running',
        startedAt: new Date().toISOString(),
        progress: accounts.map((account) => ({ account, txs: 0, skipped: 0, state: 'waiting' as const })),
        subs: new Set(),
      };
      jobs.set(job.id, job);
      void runJob(job);
      return json(res, 202, { id: job.id });
    }

    const stream = /^\/api\/jobs\/([\w-]+)\/stream$/.exec(url.pathname);
    if (req.method === 'GET' && stream) {
      const job = jobs.get(stream[1]!);
      if (!job) throw new HttpError(404, 'Unknown job.');
      res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-store', connection: 'keep-alive' });
      res.write(`data: ${JSON.stringify({ id: job.id, status: job.status, progress: job.progress })}\n\n`);
      if (job.status !== 'running') return void res.end();
      job.subs.add(res);
      req.on('close', () => job.subs.delete(res));
      return;
    }

    if (route === 'GET /api/report') {
      const { accounts, built } = await ledgerFor(url.searchParams);
      const y = url.searchParams.get('year');
      const year = y ? Number(y) : undefined;
      if (y && !/^\d{4}$/.test(y)) throw new HttpError(400, 'year must be four digits.');
      return json(res, 200, reportDto(accounts, built.events, built.result, year));
    }

    if (route === 'GET /api/export') {
      const { built } = await ledgerFor(url.searchParams);
      const { events, result } = built;
      const fmt = url.searchParams.get('format') ?? 'koinly';
      const files: Record<string, () => [string, string]> = {
        koinly: () => ['koinly.csv', koinlyCsv(events, result.pricedLegs, result.income)],
        events: () => ['events.csv', eventsCsv(events, result)],
        gains: () => ['gains.csv', gainsCsv(result)],
        income: () => ['income.csv', incomeCsv(result)],
        journal: () => ['journal.csv', journalCsv(result)],
        json: () => ['ledger.json', stringifyFixture({ events, warnings: result.warnings, positions: result.positions })],
      };
      const make = files[fmt];
      if (!make) throw new HttpError(400, `format must be one of ${Object.keys(files).join(', ')}.`);
      const [name, body] = make();
      res.writeHead(200, {
        'content-type': name.endsWith('.json') ? TYPES['.json']! : 'text/csv; charset=utf-8',
        'content-disposition': `attachment; filename="${name}"`,
        'cache-control': 'no-store',
      });
      return void res.end(body);
    }

    throw new HttpError(404, 'Not found.');
  }

  function serveStatic(res: http.ServerResponse, pathname: string): void {
    const rel = pathname === '/' ? 'index.html' : decodeURIComponent(pathname).replace(/^\/+/, '');
    const file = path.resolve(webDir, rel);
    if (file !== webDir && !file.startsWith(webDir + path.sep)) throw new HttpError(403, 'Forbidden.');
    if (!fs.existsSync(file) || !fs.statSync(file).isFile()) throw new HttpError(404, 'Not found.');
    res.writeHead(200, { 'content-type': TYPES[path.extname(file)] ?? 'application/octet-stream', 'cache-control': 'no-cache' });
    fs.createReadStream(file).pipe(res);
  }

  const server = http.createServer((req, res) => {
    res.setHeader('x-content-type-options', 'nosniff');
    res.setHeader('referrer-policy', 'no-referrer');
    res.setHeader('content-security-policy', "default-src 'self'; style-src 'self'; script-src 'self'; connect-src 'self'; img-src 'self' data:; frame-ancestors 'none'");
    void (async () => {
      try {
        if (!allowedHosts.has(req.headers.host ?? '')) throw new HttpError(403, 'Unexpected Host header.');
        const url = new URL(req.url ?? '/', `http://${req.headers.host}`);
        if (url.pathname.startsWith('/api/')) await api(req, res, url);
        else if (req.method === 'GET' || req.method === 'HEAD') serveStatic(res, url.pathname);
        else throw new HttpError(405, 'Method not allowed.');
      } catch (e) {
        const status = e instanceof HttpError ? e.status : 500;
        const message = e instanceof Error ? e.message : String(e);
        if (!res.headersSent) json(res, status, { error: status === 500 ? `Internal error: ${message}` : message });
        else res.end();
      }
    })();
  });
  server.on('close', () => store.close());
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(opts.port, host, () => resolve(server));
  });
}
