import { placeReport } from '@substrat-run/contracts';
import type { SqlExec } from './introspect.js';
import { applyPlaceReport, authMethodOf, placesOf, registrationOfClient } from './places.js';

/**
 * The HTTP half of a login's places (#1670): the read the account page makes and the report a
 * vertical makes. The rules — what an entry is, who may add or remove one, what is evidence —
 * are in `places.ts`, which is plain SQL and node-tested. This file is only their two doors,
 * kept in the worker's type universe (`tsconfig.worker.json`) beside `routes.ts` and
 * `auth-do.ts`, because it builds and answers `Request`s.
 */

/**
 * Authenticate a client the way the token endpoint does, without re-implementing it: present
 * the credentials to this issuer's own RFC 7662 introspection endpoint, which requires client
 * authentication and answers `active: false` for a token it does not know. A `200` means the
 * plugin accepted the client (secret, auth method, not disabled); anything else means it did
 * not. The credentials go the way the client registered to present them, as a relying party
 * does at `/oauth2/token`.
 */
export async function authenticateClient(
  sql: SqlExec,
  handler: (request: Request) => Promise<Response>,
  origin: string,
  clientId: string,
  clientSecret: string,
): Promise<boolean> {
  const method = authMethodOf(sql, clientId);
  if (method !== 'client_secret_post' && method !== 'client_secret_basic') return false;
  const form = new URLSearchParams({ token: 'substrat-places-client-check' });
  const headers: Record<string, string> = { 'content-type': 'application/x-www-form-urlencoded' };
  if (method === 'client_secret_post') {
    form.set('client_id', clientId);
    form.set('client_secret', clientSecret);
  } else {
    headers.authorization = `Basic ${btoa(`${encodeURIComponent(clientId)}:${encodeURIComponent(clientSecret)}`)}`;
  }
  const res = await handler(
    new Request(`${origin}/api/auth/oauth2/introspect`, { method: 'POST', headers, body: form.toString() }),
  );
  return res.status === 200;
}

/** A JSON answer that no cache keeps and no other origin may read. */
function privateJson(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json', 'cache-control': 'no-store' },
  });
}

/**
 * `GET /api/account/places` — the signed-in login's own entries. The subject comes from the
 * session and from nothing else: this reads no query string and no body, so a request naming
 * someone else's `sub` is answered exactly as the same request without it.
 */
export async function servePlaces(
  sql: SqlExec,
  session: (headers: Headers) => Promise<{ sub: string } | null>,
  headers: Headers,
): Promise<Response> {
  const subject = await session(headers);
  if (!subject) return privateJson({ error: 'sign in to see your places' }, 401);
  return privateJson({ places: placesOf(sql, subject.sub) });
}

/**
 * `POST /api/places/report` — a vertical's report, held to the three checks in this file's
 * header. `transaction` is the DO's `storage.transactionSync` (or a plain call on node), so a
 * whole-set repair lands entirely or not at all.
 */
export async function serveReport(deps: {
  sql: SqlExec;
  handler: (request: Request) => Promise<Response>;
  origin: string;
  body: unknown;
  transaction: <T>(fn: () => T) => T;
  log?: (line: string) => void;
}): Promise<Response> {
  const parsed = placeReport.safeParse(deps.body);
  if (!parsed.success) return privateJson({ error: 'malformed report' }, 400);
  const report = parsed.data;
  const registration = registrationOfClient(deps.sql, report.client_id);
  // Authentication before the registry answer, so an unauthenticated caller cannot use the
  // difference between 401 and 403 to learn which client ids are registered places.
  if (!(await authenticateClient(deps.sql, deps.handler, deps.origin, report.client_id, report.client_secret))) {
    return privateJson({ error: 'invalid client credentials' }, 401);
  }
  if (!registration) return privateJson({ error: 'this client is not registered as a place' }, 403);
  if (registration.appScopeId !== report.scope_id) {
    return privateJson({ error: 'this client is registered for a different scope' }, 403);
  }
  const outcome = deps.transaction(() => applyPlaceReport(deps.sql, registration.appScopeId, report.client_id, report));
  if (outcome.added || outcome.removed || outcome.dropped) {
    deps.log?.(`auth-server: places report ${JSON.stringify({ app: registration.appScopeId, op: report.op, ...outcome })}`);
  }
  return new Response(null, { status: 204, headers: { 'cache-control': 'no-store' } });
}
