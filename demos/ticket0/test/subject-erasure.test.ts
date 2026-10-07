import { afterAll, describe, it } from 'vitest';
import Database from 'better-sqlite3';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildHost } from '../src/seed.js';
import { checkTicket0SubjectErasure, type ErasureSql } from './subject-erasure-case.js';

describe('ticket0 subject erasure on SQLite', () => {
  const dir = mkdtempSync(join(tmpdir(), 'ticket0-erasure-'));
  const host = buildHost(dir);
  const raw: ErasureSql = async (tenant, scope, sql, params = []) => {
    const db = new Database(join(dir, `${tenant}__${scope}.sqlite`));
    try {
      const statement = db.prepare(sql);
      return statement.reader ? statement.all(...params) as Record<string, unknown>[] : (statement.run(...params), []);
    } finally {
      db.close();
    }
  };

  afterAll(async () => {
    await host.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it('erases only the customer and staff rows that belong to each subject', async () => {
    await checkTicket0SubjectErasure(host, raw);
  }, 60_000);
});
