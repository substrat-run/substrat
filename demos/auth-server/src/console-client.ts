import { HTTPException } from 'hono/http-exception';
import type { SqlExec } from './introspect.js';
import { effectiveSignIn, type SignInPolicy } from './sign-in-policy.js';

/**
 * The issuer's OWN admin console, as an application in its own registry.
 *
 * Every other screen this issuer draws belongs to a relying party, and that is what lets an
 * operator theme it (`src/branding.ts`) and narrow which methods it accepts
 * (`src/sign-in-policy.ts`) — both read per client id. The console's own sign-in had no
 * client id at all, so it was the one screen those two features could not reach: an issuer
 * could brand every application it serves except itself.
 *
 * This is that missing row. It is seeded on first boot, in both runtimes, and it carries no
 * theme and no policy — so a fresh install and an upgraded one draw exactly the screen they
 * drew before, and an operator opts in by editing it like any other application.
 *
 * ## It is a registry row, not an OAuth client
 *
 * `redirect_uris` is empty and stays empty, and that is the design rather than an omission.
 * The console signs in the way it always has — `POST /sign-in/email` or `/sign-in/social`,
 * one session cookie, no redirect — so this row exists to be READ (by `clientBranding` and
 * `readSignInPolicy`), never to complete an authorization flow. An authorize request naming
 * `client_id=console` therefore fails at the plugin's own redirect-URI match, which is the
 * fail-closed direction: nothing can be talked into using it as a relying party.
 *
 * "Stays empty" is ENFORCED, not merely seeded: the edit route refuses the OAuth half of
 * the row (`CONSOLE_LOCKED_FIELDS` below). Left open, one PATCH would have made this a
 * public client — `token_endpoint_auth_method: 'none'`, `skip_consent: 1` — with a
 * callback of the writer's choosing, which is the strongest client this issuer can hold.
 *
 * The consequence has to be said plainly, because it decides how much this feature is worth:
 * **the console's sign-in policy is not enforced.** Enforcement lives in the before-hook on
 * `/oauth2/authorize` (`src/auth.ts`), and a console sign-in never passes through there. So a
 * policy here decides which buttons the console's login screen draws and nothing else. That
 * is the honest description of "identity + policy over the same session path"; turning it
 * into a boundary means making the console a real relying party, which is a separate change.
 *
 * ## Locking yourself out
 *
 * Narrowing the console is the one policy edit that can strand its own author, so there are
 * three ways back in, deliberately at three different levels:
 *
 *  1. **`assertConsolePolicy` refuses the write** that would leave the console with no method
 *     this issuer currently offers — the intersection, not merely the structural check
 *     `assertSignInPolicy` applies to every client.
 *  2. **Disabling the row falls back to the plain screen.** `clientBranding` and
 *     `readSignInPolicy` both answer with the defaults for a disabled client, so the Disable
 *     button on the Applications screen is itself an escape hatch.
 *  3. **`/login?builtin=0`** draws the unthemed, unnarrowed screen without reading this row at
 *     all. It is a bypass anyone can type, and it is only acceptable BECAUSE of the paragraph
 *     above: there is no boundary here for it to breach.
 *
 * What none of the three can prevent is the slow version — a console restricted to an
 * upstream that is deleted or breaks afterwards. The login screen names the escape hatch when
 * it finds itself with nothing to draw, which is the only answer available at that point.
 */

/** The console's client id. Fixed and well-known: the row has to be findable by both runtimes
 *  and by an operator reading the Data tab, and nothing mints it. */
export const CONSOLE_CLIENT_ID = 'console';

/** What the Applications screen calls it. */
export const CONSOLE_CLIENT_NAME = 'Admin console';

/** Is this the built-in row? The one place the id is compared, so the answer cannot drift. */
export function isConsoleClient(clientId: string | null | undefined): boolean {
  return clientId === CONSOLE_CLIENT_ID;
}

/**
 * The client id a public per-client read is about. An absent (or empty) `client_id` is the
 * console's own screen — the only caller that has no relying party to name — so both
 * runtimes' `/client-options` route resolves it here rather than each having its own opinion.
 */
export function clientIdOrConsole(clientId: string | null | undefined): string {
  return clientId ? clientId : CONSOLE_CLIENT_ID;
}

/** SQLite's own clock, in the epoch-ms Better Auth stores dates as (as `admin-api.ts` does —
 *  the issuer's rows agree about time whichever file wrote them). */
const NOW_MS = "cast(unixepoch('subsecond') * 1000 as integer)";

/**
 * Seed the console's row if it is not there — idempotent, and safe to run on every boot in
 * both runtimes (the Durable Object's constructor, the dev server's start-up).
 *
 * `WHERE NOT EXISTS` rather than `INSERT OR REPLACE`: everything an operator puts on this row
 * — the theme, the policy, the name, whether it is disabled — must survive a restart, and a
 * replace would quietly undo it. The row is created once and then belongs to them.
 *
 * Returns whether it created one, which is only used to say so in the dev server's banner.
 */
export function ensureConsoleClient(sql: SqlExec): boolean {
  const before = sql.exec('SELECT client_id FROM oauth_client WHERE client_id = ?', CONSOLE_CLIENT_ID).toArray();
  if (before.length) return false;
  sql.exec(
    `INSERT INTO oauth_client (
       id, client_id, name, redirect_uris, post_logout_redirect_uris, scopes,
       client_credentials_scopes, disabled, skip_consent, enable_end_session,
       application_type, token_endpoint_auth_method, created_at, updated_at)
     SELECT ?, ?, ?, '[]', '[]', '[]', '[]', 0, 1, 0, 'web', 'none', ${NOW_MS}, ${NOW_MS}
     WHERE NOT EXISTS (SELECT 1 FROM oauth_client WHERE client_id = ?)`,
    CONSOLE_CLIENT_ID,
    CONSOLE_CLIENT_ID,
    CONSOLE_CLIENT_NAME,
    CONSOLE_CLIENT_ID,
  );
  return true;
}

/**
 * The OAuth half of a client row, which the console's row does not have and must not get.
 *
 * The seeded row is `redirect_uris: []`, `token_endpoint_auth_method: 'none'` and
 * `skip_consent: 1` — harmless together ONLY because the first is empty: an authorize
 * naming `client_id=console` dies at the plugin's redirect match. Write one callback
 * into it through the ordinary edit route and the same row becomes a public client that
 * skips consent, which is the strongest client this issuer can hold and nobody
 * registered it.
 *
 * So the fail-closed claim in this file's header is enforced where it can be broken,
 * rather than being a property of how the row happened to be seeded. What stays
 * editable is what the row exists FOR — its name, its icon, its theme and policy — plus
 * `disabled`, which is escape hatch 2 and must never be locked.
 */
export const CONSOLE_LOCKED_FIELDS = [
  'redirect_uris',
  'post_logout_redirect_uris',
  'application_type',
  'enable_end_session',
  'skip_consent',
] as const;

export type ConsoleLockedField = (typeof CONSOLE_LOCKED_FIELDS)[number];

/**
 * Refuse an edit that would give the console's row an OAuth surface. Named fields only:
 * a patch that mentions none of them is an ordinary edit and passes through.
 */
export function assertConsoleClientPatch(patch: Partial<Record<ConsoleLockedField, unknown>>): void {
  const named = CONSOLE_LOCKED_FIELDS.filter((field) => patch[field] !== undefined);
  if (named.length === 0) return;
  throw new HTTPException(400, {
    message:
      `the ${CONSOLE_CLIENT_NAME.toLowerCase()} is this issuer's own screen, not a relying party — ` +
      `${named.join(', ')} cannot be set on it. Its sign-in is a session on this origin, and giving ` +
      'it a callback would turn it into a consent-skipping public client nobody registered',
  });
}

/**
 * The save-time guard on the console's own policy: it must leave at least one method this
 * issuer CURRENTLY offers.
 *
 * `assertSignInPolicy` already refuses a policy that permits nothing structurally — no
 * password and no providers named. This is the stricter question, and it is the one that
 * actually locks an operator out: `{ password: false, providers: ['microsoft'] }` is a
 * perfectly well-formed policy, and on an issuer where Microsoft is not configured it is a
 * console nobody can sign into. Every other client can be written into that state and the
 * screen says so; the console is where saying so is not good enough.
 *
 * The intersection is `effectiveSignIn`'s, so this refuses exactly the policies that would
 * make the login screen draw its "accepts no sign-in method" dead end.
 */
export function assertConsolePolicy(
  policy: SignInPolicy | undefined,
  offeredProviders: readonly { id: string; label: string }[],
): void {
  if (!policy) return;
  const effective = effectiveSignIn(policy, offeredProviders);
  if (effective.password || effective.providers.length > 0) return;
  throw new HTTPException(400, {
    message:
      `the ${CONSOLE_CLIENT_NAME.toLowerCase()} must keep at least one sign-in method this issuer currently offers — ` +
      'this policy names none, and saving it would lock every administrator out of this screen',
  });
}
