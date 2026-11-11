import { z } from 'zod';
import type { SqlExec } from './introspect.js';
import { recordLogin } from './user-activity.js';

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
 * Nor the material of a DIRECT sign-in (below): no password, no emailed or texted code, no BankID
 * personal number, and no address typed for an account that does not exist — that last one is a
 * stranger's typo or an attacker's guess list, and neither is this issuer's to keep.
 *
 * ## Every way in, not only the federated one
 *
 * This table first held the federated round trip alone, on the argument that a narrower table is
 * less of somebody's sign-in activity to hold. A BankID sign-in refused at the email step then
 * left no row anywhere, and an operator read the empty log as "they never tried". The issuer
 * already holds every session; a refusal nobody can see costs more than the row would. So a
 * sign-in this issuer decides by itself — password, sign-up, invitation, SMS code, BankID, the
 * Supabase bridge — is recorded too, as one `direct` hop: `succeeded` with the account, or
 * `failed` with the refusal and, where the endpoint knew it, the account it matched
 * (`attributeSignIn`). Steps that are neither — a BankID poll still pending, an order parked for
 * its email — write nothing, since they are not an outcome yet.
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
  /** The provider id — `microsoft`, a generic row's id — or a direct method: `password`, `bankid`, … */
  method: string;
  outcome: SignInOutcome;
  /**
   * The hop: `sign-in` (we handed out an authorization URL), `callback` (it came back), or
   * `direct` (a sign-in this issuer decided by itself, with no upstream to go to).
   */
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
  /** The upstream's reason, or safe callback-stage diagnostics when it supplied none. */
  errorDescription: string | null;
  /** The relying party that sent this person here, when the flow carried one. */
  clientId: string | null;
  /**
   * The account this resolved to, once there is one. On a federated refusal, null by definition;
   * on a direct one, the account the refused sign-in matched when the endpoint knew it.
   */
  userId: string | null;
  /**
   * Which ATTEMPT this hop belongs to — see `correlationOfState`. The two rows of one round trip
   * carry the same value, and it is what makes "a `started` with nothing after it" a fact rather
   * than an inference that two people signing in at once would break.
   */
  correlation: string | null;
  /** Auth0's log type code for this hop — derived on read by `signInLogTypeOf`, never stored. */
  type: SignInLogType | null;
}

/**
 * The Auth0 log type codes this log can carry. Two: Auth0 splits a failure further (`fp` for a
 * wrong password, `fu` for an unknown user, …), and the refusal's own code in `error` already
 * says which, so borrowing those codes would add a second spelling of one fact.
 */
export type SignInLogType = 's' | 'f';

/**
 * A hop's Auth0 code: `s` (Success Login) for a succeeded hop, `f` (Failed Login) for a failed
 * one — a refusal before the person left included, since Auth0 logs that as a failed login too.
 * `started` gets NO code: Auth0 writes nothing for "sent to the upstream", and borrowing a code
 * for it would claim a compatibility this log does not have. Derived from the stored `outcome`
 * on every read, so no row was migrated to carry it.
 */
export function signInLogTypeOf(outcome: SignInOutcome): SignInLogType | null {
  if (outcome === 'succeeded') return 's';
  if (outcome === 'failed') return 'f';
  return null;
}

/** What a writer supplies. Fixed and narrow on purpose — see the module header. */
export interface SignInAttemptInput {
  method: string;
  outcome: SignInOutcome;
  phase: 'sign-in' | 'callback' | 'direct';
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
 * How long one issuer keeps a row, and the most rows it keeps whatever their age. The write
 * prunes past both.
 *
 * TIME is the rule a reader can rely on: "what happened to this person last week" has an answer
 * for 30 days, however busy the issuer. The ROW cap is only the bound — a flood of failed
 * passwords must not grow the table without limit — and it is set high enough that the same
 * flood cannot evict this morning's rows in minutes, which a 500-row ring could (it was one
 * when only federated hops were written, and a hop out takes more effort to fake). A row is
 * about 200 bytes, so the cap is around 20 MB of a Durable Object's 10 GB.
 */
export const SIGN_IN_LOG_RETENTION = { days: 30, rows: 100_000 } as const;

/** What `recordSignInAttempt` prunes against. Tests pass a small one; nothing else does. */
export interface SignInLogRetention {
  days: number;
  rows: number;
}

/**
 * How many expired rows one write removes, at most. Expired rows are always the OLDEST, so they
 * sit at the head of the rowid order and are found without a scan; a bounded batch keeps the
 * write cheap after a quiet month, and the next writes finish the job.
 */
const EXPIRED_BATCH = 50;

/** How many rows one read may ask for. The console pages; nothing needs the whole log. */
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
 * Record one hop, and prune past the retention. Never throws: this is a debugging aid bolted to the side
 * of the sign-in path, and a full disk or a schema that predates the table must cost an
 * operator their log rather than costing a user their login. The swallow is the point, and it
 * is the reason the caller in `auth.ts` needs no `try` of its own.
 */
export function recordSignInAttempt(
  sql: SqlExec,
  attempt: SignInAttemptInput,
  retention: SignInLogRetention = SIGN_IN_LOG_RETENTION,
): void {
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
    // `at` rises with `id`, so the expired rows are the first few in rowid order: read the head,
    // never the table. `at` has no index and needs none.
    sql.exec(
      `DELETE FROM sign_in_attempt
        WHERE id IN (SELECT id FROM (SELECT id, at FROM sign_in_attempt ORDER BY id LIMIT ?)
                      WHERE at < cast(unixepoch('subsecond') * 1000 as integer) - ?)`,
      EXPIRED_BATCH,
      retention.days * 24 * 60 * 60 * 1000,
    );
    // `id` is the rowid, so "the newest N" is an id comparison rather than a sort: the cap
    // trims by identity and cannot be confused by two rows landing in the same millisecond.
    sql.exec(
      `DELETE FROM sign_in_attempt
        WHERE id <= (SELECT max(id) FROM sign_in_attempt) - ?`,
      retention.rows,
    );
  } catch {
    // Deliberately silent — see above.
  }
}

/**
 * How much of the refusal's detail is kept. Entra's `error_description` carries the message,
 * a correlation id, a request id and a timestamp, and runs to several hundred characters; the
 * diagnosis is the first clause. Capped rather than unbounded because every row lives in a
 * Durable Object's SQLite for a month, and the cap is generous enough to keep the `AADSTS…` code and the
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
 * not configured at all, and what a direct sign-in answers when it refuses. The library's own
 * code (`PROVIDER_NOT_FOUND`, `INVALID_EMAIL_OR_PASSWORD`) when it set one; otherwise the
 * error's status (`conflict`, `forbidden`), since this issuer's own plugins throw with a message
 * and no code. The message rides beside it, so a row never says only "failed".
 */
export function refusalOf(error: Error): { error: string; errorDescription: string | null } {
  const code = (error as { body?: { code?: unknown } }).body?.code;
  const status = (error as { status?: unknown }).status;
  return {
    error: typeof code === 'string' && code ? code : typeof status === 'string' && status ? status.toLowerCase() : 'error',
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
 * much to collide across the rows one issuer keeps, and not reversible to the value it came from.
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

/**
 * The paths that sign someone in with no upstream to go to — each recorded as one `direct` hop by
 * the after-hook in `auth.ts`, under the method `signInMethodOfPath` stamps the session with.
 * `/github-email/verify` is not here: it finishes a federated sign-in, and that hook records it as
 * the callback it completes.
 */
export const DIRECT_SIGN_IN_PATHS: readonly string[] = [
  '/sign-in/email',
  '/sign-up/email',
  '/invitation/accept',
  '/invitation/password',
  '/phone/verify',
  '/bankid/collect',
  '/bankid/email/verify',
  '/bankid/email/skip',
  '/supabase/session',
];

/**
 * The account a refused direct sign-in matched, as the endpoint that refused it knew it.
 *
 * A refusal is a thrown `APIError`, and what it says goes to the browser — so the account cannot
 * ride on it without telling a stranger which account an address or a personal number belongs
 * to. Better Auth hands the endpoint and the after-hooks the SAME per-request `context` object
 * (it is how `setSessionCookie`'s `newSession` reaches a hook), so the endpoint notes the account
 * against that object and the hook reads it back. Keyed weakly, so nothing outlives the request.
 */
const attributed = new WeakMap<object, string>();

/** Note, from inside an endpoint, which account this sign-in is about. The latest note wins. */
export function attributeSignIn(context: object, userId: string): void {
  attributed.set(context, userId);
}

/** The account an endpoint noted for this request, if it noted one. */
export function attributedSignInOf(context: object): string | null {
  return attributed.get(context) ?? null;
}

/**
 * A `SignInLogger` over one store. What both runtimes hand to `buildAuth`.
 *
 * A `succeeded` row naming an account is also that account's login (`user-activity.ts`), kept
 * past the log's retention. A `succeeded` callback with no account is a LINK, which signs
 * nobody in, so it is not counted.
 */
export function signInLoggerFor(sql: SqlExec): SignInLogger {
  return (attempt) => {
    recordSignInAttempt(sql, attempt);
    if (attempt.outcome === 'succeeded' && attempt.userId) recordLogin(sql, attempt.userId);
  };
}

/** What the admin read accepts: a page, newest first, optionally narrowed. */
export const signInLogQuery = z.object({
  limit: z.coerce.number().int().min(1).max(SIGN_IN_LOG_PAGE_MAX).default(50),
  before: z.coerce.number().int().positive().optional(),
  method: z.string().min(1).max(40).optional(),
  /** `failed` alone is what an operator actually wants most of the time. */
  outcome: z.enum(['started', 'succeeded', 'failed']).optional(),
  /** One relying party's sign-ins — the Application's Logs tab. */
  clientId: z.string().min(1).max(256).optional(),
  /** One account's sign-ins — the User's Logs tab. A succeeded hop names its account, and so
   *  does a refused direct sign-in that matched one; a federated refusal resolved nobody. */
  userId: z.string().min(1).max(256).optional(),
});

export type SignInLogQuery = z.infer<typeof signInLogQuery>;

/** One page of the log, newest first. `before` is a previous page's last `id` — keyset rather
 *  than offset, because the log is pruned underneath a reader and an offset would skip rows. */
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
  // Both narrow to whole ATTEMPTS, not to the rows that happen to carry the column: only the
  // hop out knows the relying party (it is read off the signed `oauth_query`) and only a
  // succeeded callback knows the account, so a plain `client_id = ?` would show an application
  // every start and none of the answers — every row would look like "never came back". The
  // other hops are reached through `correlation`, which is indexed.
  for (const [column, value] of [
    ['client_id', query.clientId],
    ['user_id', query.userId],
  ] as const) {
    if (!value) continue;
    where.push(
      `(${column} = ? OR correlation IN (SELECT correlation FROM sign_in_attempt WHERE ${column} = ? AND correlation IS NOT NULL))`,
    );
    bindings.push(value, value);
  }
  const clause = where.length ? ` WHERE ${where.join(' AND ')}` : '';
  const rows = sql
    .exec(`SELECT ${COLUMNS} FROM sign_in_attempt${clause} ORDER BY id DESC LIMIT ?`, ...bindings, query.limit)
    .toArray() as unknown as AttemptRow[];
  const total = Number(
    (sql.exec('SELECT count(*) AS n FROM sign_in_attempt').toArray()[0] as { n: number }).n,
  );
  return { attempts: rows.map(attemptOf), total };
}

/**
 * How many sign-ins succeeded and failed in each window — the Overview's chart. The caller passes
 * the window BOUNDS (`bounds[i]` to `bounds[i + 1]`, ms), because "a day" is the reader's local
 * day and only the browser knows where that starts. Only `s` and `f` hops count: a hop out is
 * half an attempt, and counting it would make every federated sign-in look like two.
 *
 * Counted here rather than walked in pages on the screen: the log now holds every way in for a
 * month, so a week can be more rows than any page walk should read. `sign_in_attempt_at_idx`
 * makes each window a range read.
 */
export const signInWindowQuery = z.object({
  bounds: z
    .string()
    .transform((raw) => raw.split(',').map(Number))
    .pipe(z.array(z.number().int().nonnegative()).min(2).max(32))
    .refine((b) => b.every((v, i) => i === 0 || v > b[i - 1]!), 'bounds must increase'),
});

/**
 * Where the log starts, when the row cap rather than the age has decided it — the windows before
 * that are not counted, and a chart must say so rather than draw them as quiet days. Null while
 * the log is under its cap: then everything inside the retention is still there.
 */
export function signInLogCutAt(sql: SqlExec, retention: SignInLogRetention = SIGN_IN_LOG_RETENTION): number | null {
  const row = sql.exec('SELECT count(*) AS n, min(at) AS oldest FROM sign_in_attempt').toArray()[0] as
    | { n: number; oldest: number | null }
    | undefined;
  return row && Number(row.n) >= retention.rows && row.oldest !== null ? Number(row.oldest) : null;
}

export function countSignInsByWindow(sql: SqlExec, bounds: readonly number[]): { succeeded: number; failed: number }[] {
  return bounds.slice(1).map((end, i) => {
    const rows = sql
      .exec(
        `SELECT outcome, count(*) AS n FROM sign_in_attempt
          WHERE at >= ? AND at < ? AND outcome IN ('succeeded', 'failed') GROUP BY outcome`,
        bounds[i],
        end,
      )
      .toArray() as unknown as { outcome: string; n: number }[];
    const of = (outcome: string) => Number(rows.find((r) => r.outcome === outcome)?.n ?? 0);
    return { succeeded: of('succeeded'), failed: of('failed') };
  });
}

/**
 * One row by id, with the other hops of the same attempt, oldest first — the pair is the
 * diagnosis, so the entry's own screen needs both. Null once retention has pruned it (or it never
 * was). A row with no `correlation` has nothing to join on and so no related hops, rather than
 * being joined to every other uncorrelated row.
 */
export function readSignInLogEntry(
  sql: SqlExec,
  id: number,
): { attempt: SignInAttempt; related: SignInAttempt[] } | null {
  const row = sql.exec(`SELECT ${COLUMNS} FROM sign_in_attempt WHERE id = ?`, id).toArray()[0] as unknown as
    | AttemptRow
    | undefined;
  if (!row) return null;
  const related = row.correlation
    ? (sql
        .exec(
          `SELECT ${COLUMNS} FROM sign_in_attempt WHERE correlation = ? AND id <> ? ORDER BY id ASC`,
          row.correlation,
          id,
        )
        .toArray() as unknown as AttemptRow[])
    : [];
  return { attempt: attemptOf(row), related: related.map(attemptOf) };
}

interface AttemptRow {
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
}

function attemptOf(row: AttemptRow): SignInAttempt {
  const outcome = row.outcome as SignInOutcome;
  return {
    id: Number(row.id),
    at: Number(row.at),
    method: row.method,
    outcome,
    phase: row.phase,
    authority: row.authority,
    error: row.error,
    errorDescription: row.error_description,
    clientId: row.client_id,
    userId: row.user_id,
    correlation: row.correlation,
    type: signInLogTypeOf(outcome),
  };
}
