import {
  MAX_PLACE_MEMBERS,
  PLACES_DISCOVERY_PATH,
  placesDiscovery,
} from '@substrat-run/contracts';
import { globalFetch, type ConnectorRequestInit, type FetchLike } from '@substrat-run/kernel';
import type { AuthChoice } from './instance-auth.js';
import type { IdentityStub } from './identity-do.js';

/**
 * The vertical's half of a login's PLACES (#1670): telling the identity pool when a `sub`
 * becomes, or stops being, bound in this app's scope.
 *
 * The index lives at the issuer, keyed on the `sub` it minted, and is shown only to that login
 * on the issuer's own origin. A vertical never reads it; this module only writes to it, and
 * only about its own scope. What the vertical says is deliberately thin: "this subject is bound
 * here" or "no longer", authenticated as the OIDC client the platform registered for this app.
 * Which tenant, hostname and name the entry carries is the platform's registration, not
 * anything sent from here, and the issuer keeps an addition only for a login it has itself
 * issued to this client for (`demos/auth-server/src/places.ts` has the checks).
 *
 * ## When it reports
 *
 *   - **`observePlace`**, after the vertical resolves a signed-in subject (its `/api/me`):
 *     bound ⇒ present, unbound ⇒ absent. Deduplicated per isolate, so it costs one request per
 *     login per isolate, not per page load. It catches every way a binding is made (the first
 *     sign-in claiming the owner seat, a claim link, an accepted invite) at the next request
 *     the person makes, without wiring each of those paths.
 *   - **`unbindMember`**, which removes a binding and reports it gone in the same call.
 *   - **`reportScopeMembers`**, the repair: the whole set bound in the scope, which drops every
 *     entry it does not name. Run it from the platform's reconcile.
 *
 * ## Where the secret goes
 *
 * The report carries the install's `client_secret`, and the endpoint comes out of a document the
 * issuer serves. So the endpoint is held to the issuer's own ORIGIN (scheme, host and port,
 * exactly), to `https:` (`http:` only on a loopback issuer, which is what the dev issuer is), and
 * to no embedded credentials; and the POST is made with `redirect: 'manual'`, so a 30x is a
 * failure and never a second hop for the secret. A refused endpoint sends nothing, is reported as
 * `failed` like an unreachable issuer, and is logged once with its origin only (#1771).
 *
 * Every report is best-effort and **never throws**: a login must never fail because the index
 * could not be told. A lost report is what the repair exists for.
 *
 * ## Which issuers hear anything
 *
 * Only one that answers `PLACES_DISCOVERY_PATH`, which the platform's team auth-server does. An
 * external issuer (Supabase, Auth0, …) keeps no index for us, so it is asked once per isolate
 * where to report, answers 404, and is never sent a report.
 */

/** How a report came out. Never thrown; for a caller that logs it and a test that pins it. */
export type PlaceReportResult =
  | { outcome: 'sent' }
  /** The issuer keeps no places index (an external issuer) — nothing was sent. */
  | { outcome: 'no-index' }
  /** The issuer refused: credentials, registration or scope. Its status says which. */
  | { outcome: 'refused'; status: number }
  | { outcome: 'failed'; reason: string };

export interface PlacesReporter {
  /** The issuer this reporter reports to. */
  readonly issuer: string;
  present(scopeId: string, sub: string): Promise<PlaceReportResult>;
  absent(scopeId: string, sub: string): Promise<PlaceReportResult>;
  /** The WHOLE set bound in the scope. At most `MAX_PLACE_MEMBERS`. */
  replace(scopeId: string, subs: readonly string[]): Promise<PlaceReportResult>;
}

/** How long an issuer's answer to discovery is believed, either way. */
const DISCOVERY_TTL_MS = 10 * 60_000;

/** Per isolate: issuer → where it takes reports (null = it keeps no index), and until when. */
const discovered = new Map<string, { endpoint: string | null; until: number }>();

const LOOPBACK_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]']);

/** Why `endpoint` may not receive the client secret of `issuer`, or null when it may. */
function endpointRefusal(issuer: string, endpoint: string): string | null {
  let e: URL;
  let i: URL;
  try {
    e = new URL(endpoint);
    i = new URL(issuer);
  } catch {
    return 'not a URL';
  }
  if (e.origin !== i.origin) return `origin ${e.origin} is not the issuer's ${i.origin}`;
  if (e.username || e.password) return 'carries credentials';
  if (e.protocol !== 'https:' && !(e.protocol === 'http:' && LOOPBACK_HOSTS.has(e.hostname))) {
    return `scheme ${e.protocol} is not https`;
  }
  return null;
}

/** Per isolate: the refusals already logged, so a request path that repeats does not flood. */
const refusalLogged = new Set<string>();

const reasonOf = (e: unknown): string => (e instanceof Error ? e.message : String(e));

async function reportEndpointOf(issuer: string, fetchImpl: FetchLike, now: number): Promise<string | null> {
  const cached = discovered.get(issuer);
  if (cached && cached.until > now) return cached.endpoint;
  const res = await fetchImpl(`${issuer.replace(/\/$/, '')}${PLACES_DISCOVERY_PATH}`, {
    headers: { accept: 'application/json' },
  });
  // A definite "no" is a 4xx. A 5xx or a network failure is NOT an answer, so it is thrown
  // and not cached: an issuer that hiccuped must not be written off for ten minutes.
  if (res.status >= 500) throw new Error(`places discovery at ${issuer} answered ${res.status}`);
  let endpoint: string | null = null;
  if (res.ok) {
    const parsed = placesDiscovery.safeParse(await res.json().catch(() => null));
    endpoint = parsed.success ? parsed.data.report_endpoint : null;
  }
  discovered.set(issuer, { endpoint, until: now + DISCOVERY_TTL_MS });
  return endpoint;
}

/**
 * The reporter for an instance's configured identity, or null when it has none to report
 * with: no delivered `substrat:auth`, or one without a client secret (a public client cannot
 * authenticate a report, and the issuer would refuse it).
 */
export function placesReporter(opts: {
  identity: AuthChoice | null;
  fetch?: FetchLike;
  now?: () => number;
  log?: (line: string) => void;
}): PlacesReporter | null {
  const identity = opts.identity;
  if (!identity?.issuer || !identity.clientId || !identity.clientSecret) return null;
  const { issuer, clientId, clientSecret } = identity;
  const fetchImpl = opts.fetch ?? globalFetch;
  const now = opts.now ?? Date.now;
  const log = opts.log ?? ((line: string) => console.warn(line));

  /** A report, less the client credentials `send` adds: what the contracts' `placeReport` takes. */
  type ReportBody = { scope_id: string } & ({ op: 'present' | 'absent'; sub: string } | { op: 'replace'; subs: string[] });

  async function send(body: ReportBody): Promise<PlaceReportResult> {
    try {
      const endpoint = await reportEndpointOf(issuer, fetchImpl, now());
      if (!endpoint) return { outcome: 'no-index' };
      const refusal = endpointRefusal(issuer, endpoint);
      if (refusal) {
        // Logged with the endpoint's origin only: its path and query are the issuer's to keep.
        const shown = new URL(endpoint).origin;
        if (!refusalLogged.has(`${issuer}|${shown}`)) {
          refusalLogged.add(`${issuer}|${shown}`);
          log(`vertical-auth: places report to ${shown} refused — ${refusal}; the client secret was not sent`);
        }
        return { outcome: 'failed', reason: `places report endpoint refused: ${refusal}` };
      }
      // `redirect` is a field the runtime's fetch reads and `ConnectorRequestInit` does not name.
      const init: ConnectorRequestInit & { redirect: 'manual' } = {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ client_id: clientId, client_secret: clientSecret, ...body }),
        redirect: 'manual',
      };
      const res = await fetchImpl(endpoint, init);
      // With `redirect: 'manual'` a 30x (or the opaque redirect some runtimes hand back, status
      // 0) is not `ok`, not a 4xx, and so lands in `failed` below: never followed.
      if (res.status === 204 || res.ok) return { outcome: 'sent' };
      if (res.status >= 400 && res.status < 500) return { outcome: 'refused', status: res.status };
      return { outcome: 'failed', reason: `places report answered ${res.status}` };
    } catch (e) {
      return { outcome: 'failed', reason: reasonOf(e) };
    }
  }

  return {
    issuer,
    present: (scopeId, sub) => send({ scope_id: scopeId, op: 'present', sub }),
    absent: (scopeId, sub) => send({ scope_id: scopeId, op: 'absent', sub }),
    replace: async (scopeId, subs) => {
      if (subs.length > MAX_PLACE_MEMBERS) {
        return { outcome: 'failed', reason: `${subs.length} subjects exceed the ${MAX_PLACE_MEMBERS} one repair may carry` };
      }
      return send({ scope_id: scopeId, op: 'replace', subs: [...subs] });
    },
  };
}

/** How many observations one isolate remembers before it forgets the oldest. */
const OBSERVED_LIMIT = 5_000;
/**
 * How long a landed report is believed. Long enough that an active login costs one request an
 * hour, not one per page; short enough that the index heals for anyone still using the app
 * even if the pool somehow lost what it was told.
 */
const OBSERVED_TTL_MS = 60 * 60_000;
/**
 * How long a REFUSAL is believed. An app the platform has not registered yet is refused until
 * the dashboard's next pass registers it, which is minutes, so asking again on every request
 * would be noise and never asking again would leave the entry to the next repair.
 */
const REFUSED_TTL_MS = 5 * 60_000;

/** Per isolate: `issuer|scope|sub` → the state last reported, and until when to believe it. */
const observed = new Map<string, { bound: boolean; until: number }>();

/**
 * Tell the pool what a resolve just established: `principal` non-null ⇒ the subject is bound
 * in this scope, null ⇒ it is not. Reported once per isolate per state and per hour. A report
 * that FAILED is not remembered, so the next request retries it.
 */
export async function observePlace(
  reporter: PlacesReporter | null,
  scopeId: string,
  sub: string,
  principal: string | null,
  now: () => number = Date.now,
): Promise<PlaceReportResult | null> {
  if (!reporter) return null;
  const key = `${reporter.issuer}|${scopeId}|${sub}`;
  const bound = principal !== null;
  const seen = observed.get(key);
  if (seen && seen.bound === bound && seen.until > now()) return null;
  const result = bound ? await reporter.present(scopeId, sub) : await reporter.absent(scopeId, sub);
  if (result.outcome !== 'failed') {
    observed.delete(key);
    observed.set(key, { bound, until: now() + (result.outcome === 'refused' ? REFUSED_TTL_MS : OBSERVED_TTL_MS) });
    if (observed.size > OBSERVED_LIMIT) observed.delete(observed.keys().next().value as string);
  }
  return result;
}

/**
 * Remove a member: unbind the subject from the scope in the tenant's directory, then tell the
 * pool the place is gone. Returns whether a binding was there. The unbinding is the fact; the
 * report can be lost, and the next repair drops the entry regardless.
 */
export async function unbindMember(
  directory: Pick<IdentityStub, 'unbind'>,
  reporter: PlacesReporter | null,
  scopeId: string,
  sub: string,
): Promise<{ unbound: boolean; report: PlaceReportResult | null }> {
  const unbound = await directory.unbind(scopeId, sub);
  const report = reporter ? await reporter.absent(scopeId, sub) : null;
  // Whatever this isolate remembered about the subject is now wrong.
  if (reporter) observed.delete(`${reporter.issuer}|${scopeId}|${sub}`);
  return { unbound, report };
}

/**
 * The repair: report the WHOLE set of subjects bound in the scope, so the pool's entries for
 * this app become exactly those (a lost `present` and a lost `absent` both heal). A scope with
 * more than `MAX_PLACE_MEMBERS` bindings is refused and logged, never half-reported: a partial
 * set would REMOVE every entry it left out.
 */
export async function reportScopeMembers(
  directory: Pick<IdentityStub, 'subjectsOf'>,
  reporter: PlacesReporter | null,
  scopeId: string,
  log: (line: string) => void = (line) => console.warn(line),
): Promise<PlaceReportResult | null> {
  if (!reporter) return null;
  let subs: string[];
  try {
    subs = await directory.subjectsOf(scopeId, MAX_PLACE_MEMBERS + 1);
  } catch (e) {
    return { outcome: 'failed', reason: reasonOf(e) };
  }
  if (subs.length > MAX_PLACE_MEMBERS) {
    log(
      `vertical-auth: places repair for scope ${scopeId} skipped — more than ${MAX_PLACE_MEMBERS} bindings; ` +
        'a partial set would remove every entry it left out',
    );
    return { outcome: 'failed', reason: `more than ${MAX_PLACE_MEMBERS} bindings` };
  }
  return reporter.replace(scopeId, subs);
}

/** For tests: forget what this isolate discovered and observed. */
export function resetPlacesMemo(): void {
  discovered.clear();
  observed.clear();
  refusalLogged.clear();
}
