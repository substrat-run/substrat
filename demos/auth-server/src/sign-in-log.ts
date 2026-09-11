import { z } from 'zod';
import type { SqlExec } from './introspect.js';

/**
 * WHAT HAPPENED when someone tried to sign in — the issuer's own record of the attempts it
 * served, so "a user cannot sign in with Microsoft" is a row an operator can read rather than
 * a thing they have to reproduce.
 *
 * This exists because every other answer to that question had already run out:
 *
 *  - **The browser is the only witness today.** A refused federated sign-in comes back to
 *    `errorCallbackURL` with `error=…` on it, and `api.ts`'s `socialErrorFrom` renders that
 *    into prose on the sign-in screen. Good for the person standing there, worth nothing to
 *    the operator they then email: the code was in a query string on somebody else's screen,
 *    and the one account of it is their memory of the sentence.
 *  - **Nothing reaches the upstream's own reason.** Entra refuses at its end —
 *    `AADSTS50011` for an unregistered redirect URI, `AADSTS700016` for a single-tenant app
 *    addressed through the `common` authority — and says so in `error_description` on the way
 *    back to `/callback/microsoft`. Better Auth reads it, puts it on the redirect, and keeps
 *    nothing. That sentence usually IS the diagnosis, which is why it is stored verbatim.
 *  - **`console.log` is not available where the issuer runs.** A hosted install is a script in
 *    the platform's dispatch namespace; its logs are not a thing the operator who configured
 *    the provider can open. The issuer's own SQLite is — it is what the dashboard's Data tab
 *    reads and what `/internal/export` dumps — so the log lives there.
 *
 * ## Both ENDS of the round trip, deliberately
 *
 * One row per HOP, not per attempt, and the pair is what carries the diagnosis:
 *
 *   `started`   — `POST /sign-in/social` was served and this issuer handed back an
 *                 authorization URL. Its `authority` is the host (and, for Microsoft, the
 *                 directory segment) the person was actually sent to, which is the one fact
 *                 that separates "wrong tenant" from everything else and is otherwise visible
 *                 only in the browser's address bar, mid-redirect.
 *   `succeeded` /
 *   `failed`    — `/callback/:id` came back, with the provider's or Better Auth's own reason.
 *
 * A `started` with NO second row is itself a finding, and the most common shape of "login is
 * broken": the person never came back, so the refusal happened at the upstream's own screen —
 * consent denied, an account outside the directory, a tenant that does not know this app — and
 * no amount of logging on this side will say more than the authority they were sent to.
 *
 * That reading only holds because the two rows are JOINED (`correlation`, below). Without it,
 * two people signing in through the same provider at once produce `started, started, succeeded`
 * and nothing says which of them is still missing — so the one inference this table exists to
 * support would have been wrong exactly when the issuer was busy.
 *
 * ## What is NOT here
 *
 * No tokens, no codes, no `state`, no authorization URL in full (its query carries the PKCE
 * challenge and the signed `oauth_query`) — only the authority. A log of sign-in attempts that
 * leaks the material of one is a worse bug than the one it was added to diagnose, so the
 * writer takes a fixed, narrow set of fields and nothing reaches it by spread.
 *
 * Nor passwords or BankID: what went missing was the federated round trip, and a narrower table
 * is a smaller amount of somebody's sign-in activity to hold. Stated so the absence reads as a
 * decision rather than as "passwords are not working either".
 *
 * ## The one blind spot, named
 *
 * A request Better Auth refuses BEFORE dispatch — its origin/CSRF guard, which answers `403` to
 * a cross-origin POST — never reaches a hook, so it is not here. That matters only because an
 * empty log would otherwise be read as "the request never arrived", which is exactly what it
 * looks like. An issuer whose `trustedOrigins` do not include the screen the button is on
 * refuses every federated sign-in that way, and the evidence for that one is the browser:
 * a `403` from `/sign-in/social`, with no row here beside it.
 */

/** How a hop came out. `started` is not a success — it is the half of an attempt we served. */
export type SignInOutcome = 'started' | 'succeeded' | 'failed';

/** One row, as stored and as the admin API hands it out. */
export interface SignInAttempt {
  id: number;
  at: number;
  /** The provider id — `microsoft`, a generic row's id, or `password` / `bankid`. */
  method: string;
  outcome: SignInOutcome;
  /** The hop: `sign-in` (we handed out an authorization URL) or `callback` (it came back). */
  phase: string;
  /**
   * Where the person was sent, for a `started` hop — the authorization endpoint with its query
   * stripped, e.g. `login.microsoftonline.com/common/oauth2/v2.0/authorize`. `common` there,
   * against a single-tenant app registration, is the most common Entra misconfiguration and is
   * visible in no other field. See `authorityOf` for why the query never rides along.
   */
  authority: string | null;
  /** The refusal code, as Better Auth or the upstream spelled it. Null unless `failed`. */
  error: string | null;
  /** The upstream's own sentence about it — Entra's `AADSTS…` text is usually the diagnosis. */
  errorDescription: string | null;
  /** The relying party that sent this person here, when the flow carried one. */
  clientId: string | null;
  /** The account this resolved to, once there is one. Null on a refusal — by definition. */
  userId: string | null;
  /**
   * Which ATTEMPT this hop belongs to — see `correlationOfState`. The two rows of one round trip
   * carry the same value, and it is what makes "a `started` with nothing after it" a fact rather
   * than an inference that two people signing in at once would break.
   */
  correlation: string | null;
}

/** What a writer supplies. Fixed and narrow on purpose — see the module header. */
export interface SignInAttemptInput {
  method: string;
  outcome: SignInOutcome;
  phase: 'sign-in' | 'callback';
  authority?: string | null;
  error?: string | null;
  errorDescription?: string | null;
  clientId?: string | null;
  userId?: string | null;
  correlation?: string | null;
}

/** The recorder `buildAuth` is handed. A no-op is a legitimate implementation (see `auth.ts`). */
export type SignInLogger = (attempt: SignInAttemptInput) => void;

/**
 * How many rows one issuer keeps. A Durable Object's SQLite is small and nobody pays for an
 * unbounded debugging aid, so the log is a RING: the write prunes everything past this.
 *
 * 500 is chosen against the question the log answers. An operator reads it while a person is
 * on the phone saying "it does not work", so what must survive is today's attempts on a
 * normally-sized issuer — not a month of history, which is the audit log's job and not this
 * table's. A busy issuer rolling this over in an hour is a real limit, stated rather than
 * hidden: `at` is on every row, so a reader can always see how far back the window reaches.
 */
export const SIGN_IN_LOG_LIMIT = 500;

/** How many rows one read may ask for. The console pages; nothing needs the whole ring. */
export const SIGN_IN_LOG_PAGE_MAX = 100;

const COLUMNS =
  'id, at, method, outcome, phase, authority, error, error_description, client_id, user_id, correlation';

/**
 * Where a person was sent, from the authorization URL: everything EXCEPT the query.
 *
 * The split is the whole design. The query is where the material is — `code_challenge`, the
 * `state` the callback is checked against, and the signed authorize request riding in
 * `oauth_query` — so a log that stored the URL whole would carry all three for every attempt,
 * which is a worse bug than the one this table was added to diagnose. Everything diagnostic is
 * on the other side of the `?`: Entra's authority IS a path segment
 * (`login.microsoftonline.com/common/oauth2/v2.0/authorize` versus
 * `…/<tenant-guid>/oauth2/v2.0/authorize`), and `common` against a single-tenant app
 * registration is `AADSTS700016` — the most common way a Microsoft connector that looks
 * correctly configured does not work. No field other than this one says which was used.
 *
 * Taken whole rather than trimmed to a segment count: one segment is the Entra tenant but only
 * `/realms` of a Keycloak, two is the Keycloak realm but a stray `/oauth2` on the Entra one.
 * The endpoint path is the fact, and no heuristic over it beats simply keeping it.
 *
 * Unparseable in, null out: an authorization URL a provider built is not an input we validate,
 * and a log hop must never be the thing that fails a sign-in.
 */
export function authorityOf(url: string | null | undefined): string | null {
  if (!url) return null;
  try {
    const parsed = new URL(url);
    return `${parsed.host}${parsed.pathname}`;
  } catch {
    return null;
  }
}

/**
 * Record one hop, and prune the ring. Never throws: this is a debugging aid bolted to the side
 * of the sign-in path, and a full disk or a schema that predates the table must cost an
 * operator their log rather than costing a user their login. The swallow is the point, and it
 * is the reason the caller in `auth.ts` needs no `try` of its own.
 */
export function recordSignInAttempt(sql: SqlExec, attempt: SignInAttemptInput): void {
  try {
    sql.exec(
      `INSERT INTO sign_in_attempt
         (at, method, outcome, phase, authority, error, error_description, client_id, user_id, correlation)
       VALUES (cast(unixepoch('subsecond') * 1000 as integer), ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      attempt.method,
      attempt.outcome,
      attempt.phase,
      attempt.authority ?? null,
      attempt.error ?? null,
      attempt.errorDescription ?? null,
      attempt.clientId ?? null,
      attempt.userId ?? null,
      attempt.correlation ?? null,
    );
    // `id` is the rowid, so "the newest N" is an id comparison rather than a sort: the ring
    // trims by identity and cannot be confused by two rows landing in the same millisecond.
    sql.exec(
      `DELETE FROM sign_in_attempt
        WHERE id <= (SELECT max(id) FROM sign_in_attempt) - ?`,
      SIGN_IN_LOG_LIMIT,
    );
  } catch {
    // Deliberately silent — see above.
  }
}

/**
 * How much of the upstream's sentence is kept. Entra's `error_description` carries the message,
 * a correlation id, a request id and a timestamp, and runs to several hundred characters; the
 * diagnosis is the first clause. Capped rather than unbounded because this is a RING in a
 * Durable Object's SQLite, and the cap is generous enough to keep the `AADSTS…` code and the
 * sentence after it.
 */
export const DESCRIPTION_MAX = 500;

const clamp = (value: string | null | undefined): string | null =>
  value ? value.slice(0, DESCRIPTION_MAX) : null;

/**
 * The provider a `/callback/:id` hop was for.
 *
 * **The `path` a hook is handed is the ROUTE, not the URL** — the same fact that made
 * `signInMethodOfPath` stamp `null` on every provider sign-in until #1381, and the reason that
 * function is matched against a pattern with `params` beside it. This is the log's own reader
 * because it wants a different answer: `signInMethodOfPath` returns `null` for an id in
 * `RESERVED_METHOD_IDS`, which is right for a POLICY stamp (fail closed) and wrong for a log,
 * where a row named `password` should be recorded under the name it actually has.
 */
export function callbackProviderOf(
  path: string | undefined,
  params?: Record<string, string | undefined> | undefined,
): string | null {
  if (!path) return null;
  const matched = /^(?:\/oauth2)?\/callback\/(:?[A-Za-z0-9_-]+)$/.exec(path);
  const segment = matched?.[1];
  if (!segment) return null;
  const provider = segment.startsWith(':') ? params?.[segment.slice(1)] : segment;
  return provider && /^[a-z0-9](?:[a-z0-9-]{0,38}[a-z0-9])?$/.test(provider) ? provider : null;
}

/**
 * The refusal on a redirect the callback produced, or null when it carried none — which is what
 * a SUCCESS looks like, since the callback redirects either way (see the after-hook in
 * `auth.ts`). An absent location is itself a refusal with nothing to say: every path through
 * that endpoint sets one, so its absence means the hop ended somewhere none of them reach.
 */
export function errorOfRedirect(location: string | null | undefined): {
  error: string;
  errorDescription: string | null;
} | null {
  if (!location) return { error: 'no_redirect', errorDescription: null };
  let query: URLSearchParams;
  try {
    // Relative targets are legitimate here — `errorCallbackURL` is a path on this issuer — so
    // the base is only there to make them parse, and nothing of it is read.
    query = new URL(location, 'http://authority.invalid').searchParams;
  } catch {
    return null;
  }
  const error = query.get('error');
  return error ? { error, errorDescription: clamp(query.get('error_description')) } : null;
}

/**
 * The refusal behind a thrown `APIError` — what `/sign-in/social` answers when the provider is
 * not configured at all. The library's own code (`PROVIDER_NOT_FOUND`) when it set one, and the
 * message otherwise, so a row never says only "failed".
 */
export function refusalOf(error: Error): { error: string; errorDescription: string | null } {
  const code = (error as { body?: { code?: unknown } }).body?.code;
  return {
    error: typeof code === 'string' && code ? code : 'error',
    errorDescription: clamp(error.message),
  };
}

/**
 * The relying party a sign-in was serving, out of the signed `oauth_query` the pending
 * authorize request travels in. Read rather than verified: `oauthProvider`'s own before-hook
 * has already rejected an invalid signature by the time this runs, and a `client_id` is a
 * public identifier either way — this is the log saying which application the person was
 * trying to reach, which is most of what makes a row actionable when one client is restricted
 * and another is not.
 */
export function clientIdOfSignedQuery(value: unknown): string | null {
  if (typeof value !== 'string' || !value) return null;
  try {
    return new URLSearchParams(value).get('client_id');
  } catch {
    return null;
  }
}

/**
 * The value that JOINS the two rows of one attempt: a short digest of the OAuth `state`.
 *
 * The state is the only thing that survives the round trip — it goes out in the authorization
 * URL and comes back on the callback — so it is the one handle both hops can independently
 * derive the same id from. Nothing else is available: the issuer stores no server-side record of
 * a pending sign-in (that is the whole point of the signed state), and a cookie is not readable
 * from a hook in a shape that would survive the provider's redirect.
 *
 * Hashed rather than stored, and that is not decoration. The raw `state` is what the callback
 * checks the returning request against — it is the CSRF defence of the flow — so a log holding
 * it in plaintext would be a log of live single-use tokens, which is precisely the class of
 * thing this table refuses to carry. SHA-256 truncated to 16 hex characters is 64 bits: far too
 * much to collide across a 500-row ring, and not reversible to the value it came from.
 *
 * Web Crypto — the same API in Node, workerd and a browser — which is what lets one function
 * serve both runtimes with no import. Spelled as the bare `crypto`, as `bankid.ts` and
 * `supabase-token.ts` beside it are: `globalThis.crypto` is not a typed property in this
 * package's node program, and both spellings reach the same Web Crypto global.
 */
export async function correlationOfState(state: string | null | undefined): Promise<string | null> {
  if (!state) return null;
  try {
    const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(state));
    return Array.from(new Uint8Array(digest).slice(0, 8), (b) => b.toString(16).padStart(2, '0')).join('');
  } catch {
    // A runtime without Web Crypto loses the join, never the row.
    return null;
  }
}

/** The `state` in an authorization URL — the outbound half of the pair above. */
export function stateOfAuthorizationUrl(url: string | null | undefined): string | null {
  if (!url) return null;
  try {
    return new URL(url).searchParams.get('state');
  } catch {
    return null;
  }
}

/** A `SignInLogger` over one store. What both runtimes hand to `buildAuth`. */
export function signInLoggerFor(sql: SqlExec): SignInLogger {
  return (attempt) => recordSignInAttempt(sql, attempt);
}

/** What the admin read accepts: a page, newest first, optionally narrowed to one method. */
export const signInLogQuery = z.object({
  limit: z.coerce.number().int().min(1).max(SIGN_IN_LOG_PAGE_MAX).default(50),
  before: z.coerce.number().int().positive().optional(),
  method: z.string().min(1).max(40).optional(),
  /** `failed` alone is what an operator actually wants most of the time. */
  outcome: z.enum(['started', 'succeeded', 'failed']).optional(),
});

export type SignInLogQuery = z.infer<typeof signInLogQuery>;

/** One page of the log, newest first. `before` is a previous page's last `id` — keyset rather
 *  than offset, because the ring is pruned underneath a reader and an offset would skip rows. */
export function readSignInLog(sql: SqlExec, query: SignInLogQuery): { attempts: SignInAttempt[]; total: number } {
  const where: string[] = [];
  const bindings: unknown[] = [];
  if (query.before !== undefined) {
    where.push('id < ?');
    bindings.push(query.before);
  }
  if (query.method) {
    where.push('method = ?');
    bindings.push(query.method);
  }
  if (query.outcome) {
    where.push('outcome = ?');
    bindings.push(query.outcome);
  }
  const clause = where.length ? ` WHERE ${where.join(' AND ')}` : '';
  const rows = sql
    .exec(`SELECT ${COLUMNS} FROM sign_in_attempt${clause} ORDER BY id DESC LIMIT ?`, ...bindings, query.limit)
    .toArray() as unknown as {
    id: number;
    at: number;
    method: string;
    outcome: string;
    phase: string;
    authority: string | null;
    error: string | null;
    error_description: string | null;
    client_id: string | null;
    user_id: string | null;
    correlation: string | null;
  }[];
  const total = Number(
    (sql.exec('SELECT count(*) AS n FROM sign_in_attempt').toArray()[0] as { n: number }).n,
  );
  return {
    attempts: rows.map((row) => ({
      id: Number(row.id),
      at: Number(row.at),
      method: row.method,
      outcome: row.outcome as SignInOutcome,
      phase: row.phase,
      authority: row.authority,
      error: row.error,
      errorDescription: row.error_description,
      clientId: row.client_id,
      userId: row.user_id,
      correlation: row.correlation,
    })),
    total,
  };
}
