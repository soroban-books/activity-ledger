/** SQLite store (node:sqlite). Raw transactions are kept so reclassifying never refetches. */
import { DatabaseSync } from 'node:sqlite';
import type { RawTx } from './types.ts';
import { parseFixture, stringifyFixture } from './util.ts';

export class Store {
  private db: DatabaseSync;
  constructor(path: string) {
    this.db = new DatabaseSync(path);
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS txs (
        account TEXT NOT NULL, hash TEXT NOT NULL, ledger INTEGER NOT NULL, ord INTEGER NOT NULL,
        closed_at TEXT NOT NULL, json TEXT NOT NULL, PRIMARY KEY (account, hash)
      );
      CREATE INDEX IF NOT EXISTS txs_ledger ON txs (account, ledger, ord);
      CREATE TABLE IF NOT EXISTS cursors (account TEXT PRIMARY KEY, paging_token TEXT NOT NULL, updated_at TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS skipped (account TEXT NOT NULL, hash TEXT NOT NULL, ledger INTEGER, reason TEXT, PRIMARY KEY (account, hash));
      CREATE TABLE IF NOT EXISTS registry (contract TEXT PRIMARY KEY, asset TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS blend_contracts (contract TEXT PRIMARY KEY, verdict TEXT NOT NULL, checked_at TEXT NOT NULL);
    `);
  }

  putTx(account: string, tx: RawTx): void {
    this.db
      .prepare('INSERT OR REPLACE INTO txs (account, hash, ledger, ord, closed_at, json) VALUES (?,?,?,?,?,?)')
      .run(account, tx.hash, tx.ledger, tx.applicationOrder, tx.closedAt, stringifyFixture(tx));
  }
  txs(account: string): RawTx[] {
    return (this.db.prepare('SELECT json FROM txs WHERE account = ? ORDER BY ledger, ord').all(account) as { json: string }[]).map((r) =>
      parseFixture<RawTx>(r.json),
    );
  }
  cursor(account: string): string | undefined {
    const r = this.db.prepare('SELECT paging_token FROM cursors WHERE account = ?').get(account) as { paging_token: string } | undefined;
    return r?.paging_token;
  }
  setCursor(account: string, token: string): void {
    this.db.prepare('INSERT OR REPLACE INTO cursors (account, paging_token, updated_at) VALUES (?,?,?)').run(account, token, new Date().toISOString());
  }
  skip(account: string, hash: string, ledger: number, reason: string): void {
    this.db.prepare('INSERT OR REPLACE INTO skipped (account, hash, ledger, reason) VALUES (?,?,?,?)').run(account, hash, ledger, reason);
  }
  skipped(account: string): { hash: string; ledger: number; reason: string }[] {
    return this.db.prepare('SELECT hash, ledger, reason FROM skipped WHERE account = ?').all(account) as never;
  }
  /** Cached Blend pool verdicts (see blend/directory.ts). */
  blendVerdict(contract: string): { verdict: 'pool' | 'no'; checkedAt: string } | undefined {
    const r = this.db.prepare('SELECT verdict, checked_at FROM blend_contracts WHERE contract = ?').get(contract) as { verdict: 'pool' | 'no'; checked_at: string } | undefined;
    return r ? { verdict: r.verdict, checkedAt: r.checked_at } : undefined;
  }
  setBlendVerdict(contract: string, verdict: 'pool' | 'no'): void {
    this.db.prepare('INSERT OR REPLACE INTO blend_contracts (contract, verdict, checked_at) VALUES (?,?,?)').run(contract, verdict, new Date().toISOString());
  }
  /** Every account with stored data, with counts. */
  accounts(): { account: string; txs: number; skipped: number; lastLedger: number | null; updatedAt: string | null }[] {
    const rows = this.db
      .prepare(
        `SELECT a.account AS account,
                (SELECT COUNT(*) FROM txs t WHERE t.account = a.account) AS txs,
                (SELECT COUNT(*) FROM skipped s WHERE s.account = a.account) AS skipped,
                (SELECT MAX(ledger) FROM txs t WHERE t.account = a.account) AS lastLedger,
                (SELECT updated_at FROM cursors c WHERE c.account = a.account) AS updatedAt
         FROM (SELECT account FROM txs UNION SELECT account FROM cursors) a
         ORDER BY updatedAt DESC`,
      )
      .all() as never;
    return rows;
  }
  close(): void {
    this.db.close();
  }
}
