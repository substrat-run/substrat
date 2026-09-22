import { describe, it, expect, beforeEach } from 'vitest';
import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import { drizzleAdapter } from 'better-auth/adapters/drizzle';
import { MockEmailTransport } from '@substrat-run/adapter-email';
import { mcpResourceOf, oidcCallbackUrl, scopeId, tenantId, type PreviewClientMint } from '@substrat-run/contracts';
import { ulid } from '@substrat-run/kernel';
import { schema } from '../src/auth-schema.generated.js';
import { SCHEMA_STATEMENTS } from '../db/ddl.generated.js';
import { buildAuth, type Auth } from '../src/auth.js';
import type { SqlExec } from '../src/introspect.js';
import { parseResourcesEntry, RESOURCES_KEY_PREFIX, syncPlatformResources } from '../src/resources.js';
import {
  PreviewClientRefusal,
  claimsParent,
  mintPreviewClient,
  retirePreviewClients,
  type RegisterClientFn,
} from '../src/preview-clients.js';

/**
 * A preview's own client at this issuer (#1704), on the real Better Auth over better-sqlite3:
 * the registration is the plugin's own `/oauth2/register`, exactly the endpoint an install's
 * registration POSTs to, and every assertion reads the issuer's own tables.
 *
 * The properties, each with the twin that would pass if it were broken:
 *
 *   - the parent is claimed only on a PLATFORM-written binding, never on a callback match a
 *     stranger could register by DCR;
 *   - the minted client redirects to the preview and nowhere else, and prod's client row is
 *     byte-identical afterwards;
 *   - a delete reaches only clients minted for that preview — never prod's, never another
 *     preview's — and "older than the kept one" is judged by this issuer's own generation;
 *   - a mint whose record-keeping fails leaves no untagged client behind.
 */

const ORIGIN = 'http://localhost:8877';
const TENANT = tenantId.parse(ulid());
const OTHER_TENANT = tenantId.parse(ulid());
const ISSUER_SCOPE = scopeId.parse(ulid());
const PARENT = scopeId.parse(ulid());
const PARENT_HOST = 'desk-acme.global.substrat.run';
const PARENT_CALLBACK = oidcCallbackUrl(PARENT_HOST);

let db: Database.Database;
let sql: SqlExec;
let auth: Auth;
let register: RegisterClientFn;
const transaction = <T>(fn: () => T): T => db.transaction(fn)();

function sqlExecOf(database: Database.Database): SqlExec {
  return {
    exec(query: string, ...bindings: unknown[]) {
      const stmt = database.prepare(query);
      if (!stmt.reader) {
        stmt.run(...(bindings as []));
        return { columnNames: [], toArray: () => [], raw: () => [][Symbol.iterator]() };
      }
      const objects = stmt.all(...(bindings as [])) as Record<string, unknown>[];
      return {
        columnNames: stmt.columns().map((c) => c.name),
        toArray: () => objects,
        raw: () => (stmt.raw(true).all(...(bindings as [])) as unknown[][]).values(),
      };
    },
  };
}

/** A client registered the way anybody can: open DCR, no session. */
async function dcr(redirectUris: string[], name = 'Some App'): Promise<string> {
  const out = await register({ client_name: name, redirect_uris: redirectUris, token_endpoint_auth_method: 'client_secret_post' });
  return out.client_id;
}

const clientRow = (clientId: string) =>
  db.prepare('SELECT * FROM oauth_client WHERE client_id = ?').get(clientId) as Record<string, unknown> | undefined;
const clientIds = () => (db.prepare('SELECT client_id FROM oauth_client').all() as { client_id: string }[]).map((r) => r.client_id);
const previewRows = () =>
  db.prepare('SELECT generation, client_id, preview_scope_id FROM preview_client ORDER BY generation').all() as {
    generation: number;
    client_id: string;
    preview_scope_id: string;
  }[];

/** What the dashboard's places delivery writes (#1670) — a platform-only table. */
function placeBinding(app: string, tenant: string, clientId: string): void {
  db.prepare('INSERT INTO place_app (app_scope_id, tenant_id, client_id, hostname, name) VALUES (?, ?, ?, ?, ?)').run(
    app,
    tenant,
    clientId,
    PARENT_HOST,
    'Desk',
  );
}

/** What the dashboard's MCP registration writes (#1619) — a platform-marked resource row. */
function resourceBinding(app: string): void {
  syncPlatformResources(
    sql,
    parseResourcesEntry(`${RESOURCES_KEY_PREFIX}${app}`, JSON.stringify([mcpResourceOf(`https://${PARENT_HOST}`)])),
    Date.now(),
  );
}

const check = (over: Partial<{ tenantId: string; parentScopeId: string; parentRedirectUris: string[] }> = {}) =>
  claimsParent(sql, {
    tenantId: TENANT,
    scopeId: ISSUER_SCOPE,
    parentScopeId: PARENT,
    parentRedirectUris: [PARENT_CALLBACK],
    ...over,
  } as never);

const mintInput = (preview: string, tag = 'pr-7'): PreviewClientMint =>
  ({
    tenantId: TENANT,
    scopeId: ISSUER_SCOPE,
    parentScopeId: PARENT,
    parentRedirectUris: [PARENT_CALLBACK],
    previewScopeId: preview,
    redirectUri: oidcCallbackUrl(`desk-acme--${tag}.global.substrat.run`),
    postLogoutRedirectUri: `https://desk-acme--${tag}.global.substrat.run/`,
    clientName: `Desk (${tag})`,
  }) as PreviewClientMint;

const retire = (preview: string, opts: { keep?: string; only?: string } = {}) =>
  transaction(() => retirePreviewClients(sql, { tenantId: TENANT, scopeId: ISSUER_SCOPE, previewScopeId: preview, ...opts } as never));

beforeEach(() => {
  db = new Database(':memory:');
  for (const stmt of SCHEMA_STATEMENTS) db.exec(stmt);
  sql = sqlExecOf(db);
  auth = buildAuth({
    database: drizzleAdapter(drizzle(db, { schema }), { provider: 'sqlite', schema }),
    secret: 'test-secret-000000000000000000000000',
    baseURL: ORIGIN,
    trustedOrigins: [ORIGIN],
    transport: new MockEmailTransport(),
    sender: { email: 'no-reply@send.substrat.test', name: 'Substrat Auth' },
    allowSignup: true,
  });
  register = async (body) => {
    const res = await auth.handler(
      new Request(`${ORIGIN}/api/auth/oauth2/register`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      }) as never,
    );
    expect(res.status).toBe(201);
    return (await res.json()) as { client_id: string; client_secret: string };
  };
});

describe('claiming the parent (#1704) — a platform fact, not a callback match', () => {
  it('a client redirecting to the parent is NOT enough: open DCR lets anybody register one', async () => {
    await dcr([PARENT_CALLBACK], 'Not the platform');
    expect(check()).toBe(false);
  });

  it('claims on a places binding (#1670) plus a live client redirecting to the parent', async () => {
    const prod = await dcr([PARENT_CALLBACK]);
    placeBinding(PARENT, TENANT, prod);
    expect(check()).toBe(true);
  });

  it('claims on a platform resource binding (#1619) plus a live client redirecting to the parent', async () => {
    await dcr([PARENT_CALLBACK]);
    resourceBinding(PARENT);
    expect(check()).toBe(true);
  });

  it('a binding without a live client redirecting to the parent is not a claim', async () => {
    placeBinding(PARENT, TENANT, 'gone-client');
    expect(check()).toBe(false);
    const prod = await dcr([PARENT_CALLBACK]);
    db.prepare('UPDATE oauth_client SET disabled = 1 WHERE client_id = ?').run(prod);
    expect(check()).toBe(false);
  });

  it('a binding for another scope, another tenant, or an operator-owned resource claims nothing', async () => {
    const prod = await dcr([PARENT_CALLBACK]);
    placeBinding(scopeId.parse(ulid()), TENANT, prod);
    expect(check()).toBe(false);
    db.prepare('DELETE FROM place_app').run();
    placeBinding(PARENT, OTHER_TENANT, prod);
    expect(check()).toBe(false);
    // An operator's own row carries no platform marker — the same identifier, not a binding.
    db.prepare("INSERT INTO oauth_resource (id, identifier, name, metadata) VALUES ('r1', ?, 'op', NULL)").run(
      mcpResourceOf(`https://${PARENT_HOST}`),
    );
    expect(check()).toBe(false);
  });

  it('a row whose redirect_uris is not JSON is read as having none, never as a crash', async () => {
    const prod = await dcr([PARENT_CALLBACK]);
    placeBinding(PARENT, TENANT, prod);
    await dcr(['https://elsewhere.example/cb']);
    db.prepare("UPDATE oauth_client SET redirect_uris = 'not json' WHERE client_id <> ?").run(prod);
    expect(check()).toBe(true);
  });
});

describe('minting a preview client (#1704)', () => {
  let prod: string;
  beforeEach(async () => {
    prod = await dcr([PARENT_CALLBACK], 'Desk');
    placeBinding(PARENT, TENANT, prod);
  });

  it('registers EXACTLY the preview’s two URIs, never the parent’s, and leaves prod’s client byte-identical', async () => {
    const before = clientRow(prod);
    const preview = scopeId.parse(ulid());
    const minted = await mintPreviewClient(sql, register, mintInput(preview), transaction);
    const row = clientRow(minted.clientId)!;
    expect(JSON.parse(String(row.redirect_uris))).toEqual([oidcCallbackUrl('desk-acme--pr-7.global.substrat.run')]);
    expect(JSON.parse(String(row.post_logout_redirect_uris))).toEqual(['https://desk-acme--pr-7.global.substrat.run/']);
    expect(String(row.redirect_uris)).not.toContain(PARENT_CALLBACK);
    // The secret is handed back once and stored hashed — the row does not hold it.
    expect(minted.clientSecret.length).toBeGreaterThan(10);
    expect(String(row.client_secret)).not.toBe(minted.clientSecret);
    expect(clientRow(prod)).toEqual(before);
    expect(previewRows()).toEqual([{ generation: minted.generation, client_id: minted.clientId, preview_scope_id: preview }]);
  });

  it('refuses a parent this issuer does not claim — 409, and nothing registered', async () => {
    db.prepare('DELETE FROM place_app').run();
    const before = clientIds();
    await expect(mintPreviewClient(sql, register, mintInput(scopeId.parse(ulid())), transaction)).rejects.toMatchObject({
      status: 409,
    });
    expect(clientIds()).toEqual(before);
  });

  it('refuses a preview URI equal to a parent callback — a preview client never stands in for prod’s', async () => {
    const before = clientIds();
    const input = { ...mintInput(scopeId.parse(ulid())), redirectUri: PARENT_CALLBACK };
    const err = await mintPreviewClient(sql, register, input, transaction).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(PreviewClientRefusal);
    expect((err as PreviewClientRefusal).status).toBe(400);
    expect(clientIds()).toEqual(before);
  });

  it('generations only grow, even across deletes (AUTOINCREMENT, never reused)', async () => {
    const preview = scopeId.parse(ulid());
    const a = await mintPreviewClient(sql, register, mintInput(preview), transaction);
    const b = await mintPreviewClient(sql, register, mintInput(preview), transaction);
    retire(preview);
    const c = await mintPreviewClient(sql, register, mintInput(preview), transaction);
    expect(a.generation).toBeLessThan(b.generation);
    expect(b.generation).toBeLessThan(c.generation);
  });

  it('a mint whose record-keeping throws removes the client it just registered — no untagged leftover', async () => {
    const before = clientIds();
    let calls = 0;
    const failingOnce = <T>(fn: () => T): T => {
      calls += 1;
      if (calls === 1) throw new Error('storage blip');
      return transaction(fn);
    };
    await expect(mintPreviewClient(sql, register, mintInput(scopeId.parse(ulid())), failingOnce)).rejects.toThrow('storage blip');
    expect(clientIds()).toEqual(before);
    expect(previewRows()).toEqual([]);
  });
});

describe('retiring preview clients (#1704) — by tag, and by generation', () => {
  let prod: string;
  beforeEach(async () => {
    prod = await dcr([PARENT_CALLBACK], 'Desk');
    placeBinding(PARENT, TENANT, prod);
  });
  const mint = (preview: string) => mintPreviewClient(sql, register, mintInput(preview), transaction);

  it('a reap deletes every client of THAT preview — and never prod’s, nor another preview’s', async () => {
    const p1 = scopeId.parse(ulid());
    const p2 = scopeId.parse(ulid());
    const a = await mint(p1);
    const b = await mint(p1);
    const other = await mint(p2);
    const out = retire(p1);
    expect(out).toEqual({ deleted: [a.clientId, b.clientId], kept: null, superseded: false });
    expect(clientIds().sort()).toEqual([prod, other.clientId].sort());
  });

  it('no preview scope id reaches an untagged client — prod’s survives a delete for every preview there is', async () => {
    const p1 = scopeId.parse(ulid());
    await mint(p1);
    const before = clientRow(prod);
    for (const preview of [p1, PARENT, ISSUER_SCOPE, scopeId.parse(ulid())]) {
      retire(preview);
      retire(preview, { only: prod });
      retire(preview, { keep: prod });
    }
    expect(clientRow(prod)).toEqual(before);
  });

  it('keep deletes only OLDER clients, and says whether a newer one exists', async () => {
    const preview = scopeId.parse(ulid());
    const a = await mint(preview);
    const b = await mint(preview);
    const c = await mint(preview);
    expect(retire(preview, { keep: b.clientId })).toEqual({ deleted: [a.clientId], kept: true, superseded: true });
    expect(clientIds()).toContain(c.clientId);
    expect(retire(preview, { keep: c.clientId })).toEqual({ deleted: [b.clientId], kept: true, superseded: false });
  });

  it('keep of a client that is gone deletes nothing and answers kept: false', async () => {
    const preview = scopeId.parse(ulid());
    const a = await mint(preview);
    const b = await mint(preview);
    retire(preview, { only: b.clientId });
    expect(retire(preview, { keep: b.clientId })).toEqual({ deleted: [], kept: false, superseded: false });
    expect(clientIds()).toContain(a.clientId);
  });

  it('only deletes that one client, and only if it is this preview’s', async () => {
    const p1 = scopeId.parse(ulid());
    const p2 = scopeId.parse(ulid());
    const a = await mint(p1);
    const b = await mint(p2);
    expect(retire(p1, { only: b.clientId }).deleted).toEqual([]);
    expect(retire(p1, { only: a.clientId }).deleted).toEqual([a.clientId]);
    expect(clientIds()).toContain(b.clientId);
  });

  it('a retired client’s tokens and consents go with it', async () => {
    const preview = scopeId.parse(ulid());
    const a = await mint(preview);
    const user = (await auth.api.signUpEmail({ body: { email: 'u@x.test', password: 'long-enough-pass', name: 'U' } })).user;
    db.prepare(
      "INSERT INTO oauth_consent (id, client_id, user_id, scopes, created_at, updated_at) VALUES ('c1', ?, ?, '[\"openid\"]', 0, 0)",
    ).run(a.clientId, user.id);
    retire(preview);
    expect(db.prepare('SELECT count(*) AS n FROM oauth_consent').get()).toEqual({ n: 0 });
    expect(clientRow(a.clientId)).toBeUndefined();
  });
});
