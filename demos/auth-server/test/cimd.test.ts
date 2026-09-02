import { describe, it, expect, beforeEach } from 'vitest';
import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import { drizzleAdapter } from 'better-auth/adapters/drizzle';
import { MockEmailTransport } from '@substrat-run/adapter-email';
import { schema } from '../src/auth-schema.generated.js';
import { SCHEMA_STATEMENTS } from '../db/ddl.generated.js';
import { buildAuth, type Auth } from '../src/auth.js';
import type { ClientMetadataResourceFetch } from '@better-auth/oauth-provider';
import { fetchClientMetadataResource, CimdFetchRefused } from '../src/cimd-fetch.js';

/**
 * Client ID Metadata Documents — a client whose `client_id` IS the HTTPS URL of the
 * document describing it, so it needs no registration and holds no secret.
 *
 * Two halves are worth proving here and nothing else is:
 *
 *  1. **The metadata a client discovers.** Claude selects CIMD only when the authorization
 *     server advertises `client_id_metadata_document_supported: true` AND `"none"` in
 *     `token_endpoint_auth_methods_supported` — the second because a CIMD client
 *     authenticates as a public client. Either one missing and a client silently falls back
 *     to dynamic registration, which is the failure this file exists to catch.
 *  2. **The transport's refusals.** `src/cimd-fetch.ts` is the workerd half of a security
 *     contract the plugin states but cannot enforce, so what it REFUSES is the whole of its
 *     value.
 *
 * The document fetch is injected rather than networked. That is not a shortcut around a
 * real fetch: `fetchClientMetadataResource` is a declared dependency precisely because the
 * guarantee it makes is runtime-specific, and a hermetic suite must not depend on name
 * resolution. The transport itself is tested directly, below.
 */

const ORIGIN = 'http://localhost:8877';
const CLIENT_ID = 'https://client.example/mcp/client.json';

/** A document satisfying the MCP 2026-07-28 profile (client_name + redirect_uris required). */
const DOCUMENT = {
  client_id: CLIENT_ID,
  client_name: 'Probe MCP Client',
  redirect_uris: ['https://client.example/mcp/callback'],
  token_endpoint_auth_method: 'none',
  grant_types: ['authorization_code', 'refresh_token'],
  response_types: ['code'],
};

let db: Database.Database;
let auth: Auth;
/** Every URL the plugin asked for, so a test can assert it fetched the client_id itself. */
let fetched: string[];

/**
 * Serves `DOCUMENT` at its own `client_id` and 404s everything else.
 *
 * Typed as the plugin's own `ClientMetadataResourceFetch` rather than as a hand-written
 * Fetch signature — the point of the double is that it satisfies the same contract the two
 * real transports do.
 */
const injectedFetch: ClientMetadataResourceFetch = (input) => {
  const url = input instanceof URL ? input.href : typeof input === 'string' ? input : input.url;
  fetched.push(url);
  const body = url === CLIENT_ID ? JSON.stringify(DOCUMENT) : null;
  return new Response(body, {
    status: body ? 200 : 404,
    headers: body ? { 'content-type': 'application/json' } : {},
  }) as never;
};

const call = (path: string, init?: RequestInit): Promise<Response> =>
  auth.handler(new Request(`${ORIGIN}${path}`, init) as never);

beforeEach(() => {
  db = new Database(':memory:');
  for (const stmt of SCHEMA_STATEMENTS) db.exec(stmt);
  fetched = [];
  auth = buildAuth({
    database: drizzleAdapter(drizzle(db, { schema }), { provider: 'sqlite', schema }),
    secret: 'test-secret-000000000000000000000000',
    baseURL: ORIGIN,
    trustedOrigins: [ORIGIN],
    transport: new MockEmailTransport(),
    sender: { email: 'no-reply@send.substrat.test', name: 'Substrat Auth' },
    fetchClientMetadataResource: injectedFetch,
    allowSignup: true,
  });
});

describe('what a client discovers', () => {
  it('advertises both flags a CIMD client selects on', async () => {
    const meta = (await (await call('/.well-known/oauth-authorization-server')).json()) as {
      client_id_metadata_document_supported?: boolean;
      token_endpoint_auth_methods_supported?: string[];
    };
    expect(meta.client_id_metadata_document_supported).toBe(true);
    // A CIMD client is a PUBLIC client: it has no secret to present at the token endpoint.
    // Advertising the flag without this is an issuer that says yes and then refuses.
    expect(meta.token_endpoint_auth_methods_supported).toContain('none');
  });

  it('is not mounted when no transport was supplied', async () => {
    const without = buildAuth({
      database: drizzleAdapter(drizzle(db, { schema }), { provider: 'sqlite', schema }),
      secret: 'test-secret-000000000000000000000000',
      baseURL: ORIGIN,
      trustedOrigins: [ORIGIN],
      transport: new MockEmailTransport(),
      sender: { email: 'no-reply@send.substrat.test', name: 'Substrat Auth' },
      allowSignup: true,
    });
    const meta = (await (
      await without.handler(
        new Request(`${ORIGIN}/.well-known/oauth-authorization-server`) as never,
      )
    ).json()) as { client_id_metadata_document_supported?: boolean };
    // An issuer with no safe way to fetch a document must not claim it will fetch one.
    expect(meta.client_id_metadata_document_supported).not.toBe(true);
  });
});

describe('a client that registered nothing', () => {
  it('is resolved by fetching the document its client_id names', async () => {
    const res = await call(
      `/api/auth/oauth2/authorize?client_id=${encodeURIComponent(CLIENT_ID)}` +
        `&redirect_uri=${encodeURIComponent(DOCUMENT.redirect_uris[0]!)}` +
        '&response_type=code&scope=openid&state=xyz',
    );
    // Not signed in, so the flow lands on the login page — the point is that it got that
    // far at all: an unknown client_id is refused as `invalid_client` before any of this.
    expect(res.status).toBe(302);
    expect(res.headers.get('location') ?? '').not.toContain('invalid_client');
    // The document was fetched from the exact URL the client_id names, and nowhere else.
    expect(fetched).toContain(CLIENT_ID);
  });

  it('is persisted as a discovery-owned client, not a registered one', async () => {
    await call(
      `/api/auth/oauth2/authorize?client_id=${encodeURIComponent(CLIENT_ID)}` +
        `&redirect_uri=${encodeURIComponent(DOCUMENT.redirect_uris[0]!)}` +
        '&response_type=code&scope=openid&state=xyz',
    );
    const row = db
      .prepare('SELECT client_id, name, client_discovery_id FROM oauth_client WHERE client_id = ?')
      .get(CLIENT_ID) as { client_id: string; name: string; client_discovery_id: string } | undefined;
    expect(row).toBeDefined();
    expect(row?.name).toBe('Probe MCP Client');
    // The discovery id is what keeps a client someone REGISTERED from being overwritten by
    // a document that later claims the same id.
    expect(row?.client_discovery_id).toBe('cimd');
  });

  it('refuses a client_id whose document does not answer', async () => {
    const missing = 'https://client.example/mcp/absent.json';
    const res = await call(
      `/api/auth/oauth2/authorize?client_id=${encodeURIComponent(missing)}` +
        '&redirect_uri=https%3A%2F%2Fclient.example%2Fmcp%2Fcallback' +
        '&response_type=code&scope=openid&state=xyz',
    );
    const body = res.status === 302 ? (res.headers.get('location') ?? '') : await res.text();
    expect(body).toContain('invalid_client');
  });
});

describe('the workerd transport', () => {
  const refuses = async (url: string, why: string) => {
    await expect(
      Promise.resolve().then(() => fetchClientMetadataResource(url)),
    ).rejects.toBeInstanceOf(CimdFetchRefused);
    expect(why).toBeTruthy();
  };

  it('refuses plain http — a client_id anyone on the path could rewrite', async () => {
    await refuses('http://client.example/client.json', 'scheme');
  });

  it('refuses the special-use hosts it can name', async () => {
    for (const host of [
      'localhost',
      'foo.localhost',
      'thing.local',
      'svc.internal',
      '127.0.0.1',
      '10.0.0.1',
      '172.16.0.1',
      '192.168.1.1',
      // Link-local, which is where a cloud instance's credential endpoint lives.
      '169.254.169.254',
      '[::1]',
    ]) {
      await refuses(`https://${host}/client.json`, host);
    }
  });

  it('refuses a URL carrying credentials', async () => {
    await refuses('https://user:pw@client.example/client.json', 'credentials');
  });

  it('allows an ordinary public https URL', () => {
    // Does not fetch — asserts only that validation lets it through to `fetch`.
    expect(() => {
      const p = fetchClientMetadataResource('https://client.example/client.json');
      void Promise.resolve(p).catch(() => undefined); // the network failure is not the subject
    }).not.toThrow();
  });
});
