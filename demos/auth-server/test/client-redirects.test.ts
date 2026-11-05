import { beforeEach, describe, expect, it } from 'vitest';
import Database from 'better-sqlite3';
import { CLIENT_REDIRECTS_CONFIG_PREFIX, scopeId } from '@substrat-run/contracts';
import { ulid } from '@substrat-run/kernel';
import { SCHEMA_STATEMENTS } from '../db/ddl.generated.js';
import type { SqlExec } from '../src/introspect.js';
import { parseClientRedirectsEntry, syncClientRedirects } from '../src/client-redirects.js';

/**
 * Which URIs of an app's client the platform's delivery may change (#2904). The plugin's own
 * reading of the result (sign-in and sign-out on a delivered hostname) is pinned in workerd
 * (`workerd/reconcile.test.ts`); these are the ownership rules, on the issuer's own tables.
 */

const APP = scopeId.parse(ulid());
const CALLBACK = (h: string) => `https://${h}/api/auth/callback`;
const OPERATOR_URI = 'https://staging.acme.test/api/auth/callback';

let db: Database.Database;
let sql: SqlExec;

function sqlExecOf(database: Database.Database): SqlExec {
  return {
    exec(query: string, ...bindings: unknown[]) {
      const stmt = database.prepare(query);
      if (!stmt.reader) {
        stmt.run(...(bindings as []));
        return { columnNames: [], toArray: () => [], raw: () => [][Symbol.iterator]() };
      }
      const rows = stmt.all(...(bindings as [])) as Record<string, unknown>[];
      return { columnNames: [], toArray: () => rows, raw: () => [][Symbol.iterator]() };
    },
  };
}

/** A client as open DCR leaves it: its redirect URIs, no post-logout list, end-session off. */
function client(redirects: string[]): string {
  const id = ulid();
  db.prepare('INSERT INTO oauth_client (id, client_id, redirect_uris) VALUES (?, ?, ?)').run(id, id, JSON.stringify(redirects));
  return id;
}

const lists = (clientId: string) => {
  const row = db
    .prepare('SELECT redirect_uris, post_logout_redirect_uris, enable_end_session FROM oauth_client WHERE client_id = ?')
    .get(clientId) as { redirect_uris: string; post_logout_redirect_uris: string | null; enable_end_session: number | null };
  return {
    redirects: JSON.parse(row.redirect_uris) as string[],
    logouts: JSON.parse(row.post_logout_redirect_uris ?? '[]') as string[],
    endSession: row.enable_end_session === 1,
  };
};

const deliver = (target: { clientId: string; hostnames: string[] } | null) =>
  db.transaction(() =>
    syncClientRedirects(
      sql,
      parseClientRedirectsEntry(`${CLIENT_REDIRECTS_CONFIG_PREFIX}${APP}`, target ? JSON.stringify(target) : ''),
      Date.now(),
    ),
  )();

beforeEach(() => {
  db = new Database(':memory:');
  for (const stmt of SCHEMA_STATEMENTS) db.exec(stmt);
  sql = sqlExecOf(db);
});

describe("an app's client URIs follow the platform's delivery (#2904)", () => {
  it('adds and removes only the URIs it derived, and leaves an operator-added one alone', () => {
    const id = client([CALLBACK('desk.acme.test'), OPERATOR_URI]);

    deliver({ clientId: id, hostnames: ['desk.acme.test', 'desk.custom.test'] });
    expect(lists(id)).toEqual({
      redirects: [CALLBACK('desk.acme.test'), OPERATOR_URI, CALLBACK('desk.custom.test')],
      logouts: [
        'https://desk.acme.test/',
        'https://desk.acme.test/api/auth/logged-out',
        'https://desk.custom.test/',
        'https://desk.custom.test/api/auth/logged-out',
      ],
      endSession: true,
    });
    // A repeat changes nothing.
    expect(deliver({ clientId: id, hostnames: ['desk.acme.test', 'desk.custom.test'] })).toMatchObject({ added: [], removed: [] });

    deliver({ clientId: id, hostnames: ['desk.acme.test'] });
    expect(lists(id).redirects).toEqual([CALLBACK('desk.acme.test'), OPERATOR_URI]);
    expect(lists(id).logouts).toEqual(['https://desk.acme.test/', 'https://desk.acme.test/api/auth/logged-out']);

    deliver(null);
    expect(lists(id).redirects).toEqual([OPERATOR_URI]);
    expect(db.prepare('SELECT COUNT(*) AS n FROM platform_client_redirects').get()).toEqual({ n: 0 });
  });

  it('refuses a client that redirects to none of the app hostnames, writing nothing', () => {
    const console = client(['https://auth.acme.test/console/callback']);
    expect(() => deliver({ clientId: console, hostnames: ['desk.acme.test'] })).toThrow('not adopted');
    expect(lists(console)).toEqual({ redirects: ['https://auth.acme.test/console/callback'], logouts: [], endSession: false });
  });

  it('moves the managed URIs to a new client on an Identity change, taking them off the old one', () => {
    const old = client([CALLBACK('desk.acme.test')]);
    deliver({ clientId: old, hostnames: ['desk.acme.test', 'desk.custom.test'] });
    const next = client([CALLBACK('desk.acme.test')]);

    deliver({ clientId: next, hostnames: ['desk.acme.test', 'desk.custom.test'] });

    expect(lists(old).redirects).toEqual([]);
    expect(lists(next).redirects).toEqual([CALLBACK('desk.acme.test'), CALLBACK('desk.custom.test')]);
  });
});
