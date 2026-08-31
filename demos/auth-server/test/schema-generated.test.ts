import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { describe, it, expect } from 'vitest';
import Database from 'better-sqlite3';
import { getAuthTables } from 'better-auth/db';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import { drizzleAdapter } from 'better-auth/adapters/drizzle';
import { MockEmailTransport } from '@substrat-run/adapter-email';
import { schema } from '../src/auth-schema.generated.js';
import { SCHEMA_STATEMENTS } from '../db/ddl.generated.js';
import { buildAuth } from '../src/auth.js';

/**
 * The half of "GENERATED … do not edit by hand" that a diff cannot answer.
 *
 * The drift half is `pnpm lint:auth-schema --check`, a CI step of its own (#987). It used
 * to be only the first case below, which made it a gate a `pretypecheck` hook could — and
 * did — cancel by re-emitting the files on the way past. Both checks are kept: the first
 * is cheap and keeps the suite honest when run alone; the second is the one that cannot
 * move to a diff.
 *
 * `db/ddl.generated.ts` and `src/auth-schema.generated.ts` are derived from Better Auth's own
 * table declarations. Nothing stops someone editing them, and nothing would notice — until a
 * query hit a column that is not there, inside a Durable Object, in production. That was the
 * standing risk while these files were hand-maintained, and `oauthProvider` (six tables, forty
 * columns) is where hand-maintaining them stopped being plausible.
 *
 * Two assertions, and the second is the one that matters:
 *
 *   1. Re-emitting produces exactly what is checked in (`--check`).
 *   2. The emitted DDL, executed against a REAL database, satisfies the library. A string
 *      comparison proves the file matches the generator; only running it proves the generator
 *      is right — this is the check that would have caught `account.issuer`, a column 1.7
 *      added to a table that already existed, which `CREATE TABLE IF NOT EXISTS` cannot add
 *      and a diff would not have flagged.
 */

const root = join(dirname(fileURLToPath(import.meta.url)), '..');

describe('the generated schema', () => {
  it('is up to date with the plugin configuration', () => {
    // Throws (non-zero exit) when the checked-in files and a fresh emit differ.
    const out = execFileSync('npx', ['tsx', 'scripts/gen-schema.mts', '--check'], {
      cwd: root,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    expect(out).toContain('up to date');
  }, 60_000);

  it('declares every table and column Better Auth expects', async () => {
    const db = new Database(':memory:');
    for (const stmt of SCHEMA_STATEMENTS) db.exec(stmt);

    const auth = buildAuth({
      database: drizzleAdapter(drizzle(db, { schema }), { provider: 'sqlite', schema }),
      secret: 'test-secret-000000000000000000000000',
      baseURL: 'http://localhost:8877',
      trustedOrigins: ['http://localhost:8877'],
      transport: new MockEmailTransport(),
      sender: { email: 'no-reply@send.substrat.test', name: 'Substrat Auth' },
    });

    const tables = getAuthTables(auth.options as never) as Record<
      string,
      { modelName?: string; fields: Record<string, { fieldName?: string }> }
    >;
    const snake = (s: string) => s.replace(/[A-Z]/g, (c) => `_${c.toLowerCase()}`);

    for (const [model, def] of Object.entries(tables)) {
      const table = snake(def.modelName ?? model);
      const columns = (db.prepare(`PRAGMA table_info("${table}")`).all() as { name: string }[]).map((r) => r.name);
      expect(columns, `table '${table}' is missing from the emitted DDL`).not.toHaveLength(0);
      for (const [field, f] of Object.entries(def.fields)) {
        const column = snake(f.fieldName ?? field);
        expect(columns, `${table}.${column} is declared by Better Auth but not by the DDL`).toContain(column);
      }
    }
  });

  it('actually stores what the adapter writes — a real round-trip, not a string match', async () => {
    const db = new Database(':memory:');
    for (const stmt of SCHEMA_STATEMENTS) db.exec(stmt);
    const auth = buildAuth({
      database: drizzleAdapter(drizzle(db, { schema }), { provider: 'sqlite', schema }),
      secret: 'test-secret-000000000000000000000000',
      baseURL: 'http://localhost:8877',
      trustedOrigins: ['http://localhost:8877'],
      transport: new MockEmailTransport(),
      sender: { email: 'no-reply@send.substrat.test', name: 'Substrat Auth' },
      allowSignup: true,
    });

    // Sign-up writes `user`, `account` (including 1.7's `issuer`) and `session`; registering a
    // client writes `oauth_client`, whose `redirect_uris` is a `string[]` the adapter
    // serializes itself — SQLite is not a JSON provider, so a `mode: 'json'` column here would
    // double-encode and this is where that would show.
    const created = await auth.api.signUpEmail({ body: { email: 'ada@acme.test', password: 'password-1234', name: 'Ada' } });
    expect(created.user.id).toBeTruthy();
    expect((db.prepare('SELECT issuer FROM account WHERE user_id = ?').get(created.user.id) as { issuer: string }).issuer)
      .toBe('local:credential');

    const registered = await auth.handler(
      new Request('http://localhost:8877/api/auth/oauth2/register', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          redirect_uris: ['http://localhost:9999/cb', 'http://localhost:9999/other'],
          client_name: 'Shape Probe',
          application_type: 'native',
        }),
      }) as never,
    );
    expect(registered.status).toBe(201);
    const { client_id: clientId } = (await registered.json()) as { client_id: string };
    const row = db.prepare('SELECT redirect_uris FROM oauth_client WHERE client_id = ?').get(clientId) as {
      redirect_uris: string;
    };
    expect(JSON.parse(row.redirect_uris)).toEqual(['http://localhost:9999/cb', 'http://localhost:9999/other']);
  });
});
