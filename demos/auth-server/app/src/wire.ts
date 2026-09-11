/**
 * What the two PRE-AUTH reads are allowed to believe about an answer.
 *
 * Split out of `api.ts` for the reason `paths.ts` was split out of `routes.ts`: there is no
 * React and no `fetch` in here, so the issuer's own vitest — a `nodenext` program that cannot
 * compile a bundler-resolved TSX module — can import and test it directly. The behaviour below
 * is the kind that is only ever wrong in production, so being able to pin it matters more than
 * where it lives.
 *
 * ## Why this exists at all
 *
 * `/api/setup-state` and `/api/session` gate the ENTIRE app: `App.tsx` cannot pick a screen
 * until both have answered, so its phase stays `loading` — the words "Loading…", with nothing
 * else on the page — until they do. That makes them the two reads where an unchecked answer
 * does not degrade, it HANGS:
 *
 *  - `res.json()` on a body that is not JSON **rejects**. A worker exception page, a
 *    Cloudflare 5xx, anything an intermediary substitutes — all of them are HTML, and all of
 *    them turned into a promise rejection inside `refresh()`, which had no catch. The screen
 *    said "Loading…" and meant "this failed four seconds ago and nobody is going to tell you".
 *  - `res.json()` on an ERROR ENVELOPE resolves perfectly well. `routes.ts` answers a failure
 *    as `{ error: … }`, and `{ error: … }` is a truthy object: handed back as a session it made
 *    the console decide the person was not an administrator, and handed back as the issuer
 *    state it left `providers` undefined for a screen that reads `providers.length`.
 *
 * Neither shape is exotic and neither says anything to the person in front of it. So both reads
 * now come through here, where a failure becomes a sentence a screen can print.
 *
 * `clientOptions` deliberately does NOT: a client's theme and sign-in narrowing have a correct
 * fallback (the issuer's own plain defaults), so that read degrades instead of failing, and it
 * already did. These two have no fallback — there is no honest "probably signed in".
 */

/**
 * A pre-auth read that did not answer usably. Separate from a plain `Error` so the screen can
 * tell "the issuer could not answer" apart from a refusal with words, and say the one thing
 * that is actually true: retrying might work, and nothing the person typed caused it.
 */
export class IssuerUnreachable extends Error {
  constructor(
    message: string,
    /** The HTTP status, when there was one — `0` for an answer that never parsed. */
    readonly status: number,
  ) {
    super(message);
    this.name = 'IssuerUnreachable';
  }
}

/** The part of `Response` this needs. Narrow so a test can hand it a literal. */
export interface ReadResponse {
  ok: boolean;
  status: number;
  text(): Promise<string>;
}

/** The `{ error }` envelope `routes.ts` and the admin API answer a failure with. */
function errorTextOf(body: string): string | null {
  try {
    const parsed = JSON.parse(body) as { error?: unknown } | null;
    return parsed && typeof parsed.error === 'string' && parsed.error ? parsed.error : null;
  } catch {
    return null;
  }
}

/**
 * One pre-auth read, parsed — or an `IssuerUnreachable` naming what came back instead.
 *
 * `text()` rather than `json()`, deliberately: a body that is not JSON is the main thing this
 * guards against, and reading it as text first is what turns "SyntaxError: Unexpected token
 * '<'" into "the issuer answered 502 rather than an answer". The status is checked BEFORE the
 * shape so an error envelope is reported by its own `error` message rather than by the shape
 * it failed to be.
 *
 * `shape` is a predicate rather than a schema because this module must stay dependency-free to
 * be importable from the issuer's vitest, and because the two shapes it guards are three fields
 * each. A body that parses but is the wrong shape is the error-envelope case above, and it is
 * reported as a failure rather than passed on — passing it on is what produced a console
 * telling an administrator they were not one.
 */
export async function readIssuerJson<T>(
  res: ReadResponse,
  /** What was being read, for the message: "the issuer state", "the current session". */
  what: string,
  shape: (value: unknown) => boolean,
): Promise<T> {
  const body = await res.text().catch(() => '');
  if (!res.ok) {
    const said = errorTextOf(body);
    throw new IssuerUnreachable(
      said ? `${what} could not be read: ${said}` : `${what} could not be read (the issuer answered ${res.status}).`,
      res.status,
    );
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(body) as unknown;
  } catch {
    throw new IssuerUnreachable(
      `${what} came back as something other than an answer (${res.status}). The issuer may be mid-deploy.`,
      res.status,
    );
  }
  if (!shape(parsed)) {
    const said = errorTextOf(body);
    throw new IssuerUnreachable(
      said ? `${what} could not be read: ${said}` : `${what} came back in a shape this screen does not recognise.`,
      res.status,
    );
  }
  return parsed as T;
}

/** The issuer state's shape. The three fields `App.tsx` reads, including the array it indexes. */
export function isIssuerState(value: unknown): boolean {
  if (!value || typeof value !== 'object') return false;
  const v = value as Record<string, unknown>;
  return typeof v.needsSetup === 'boolean' && typeof v.signupEnabled === 'boolean' && Array.isArray(v.providers);
}

/**
 * A session, or `null` for nobody signed in — and `null` IS a valid answer here, which is why
 * this is not simply "an object with a `sub`". The distinction it holds is the load-bearing one:
 * a READ that failed must never look like "signed out", because signing someone out who is
 * signed in sends them to a login screen that will hand them straight back.
 */
export function isSessionOrNull(value: unknown): boolean {
  if (value === null) return true;
  if (!value || typeof value !== 'object') return false;
  return typeof (value as Record<string, unknown>).sub === 'string';
}
