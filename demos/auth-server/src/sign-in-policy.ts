import { z } from 'zod';
import type { SqlExec } from './introspect.js';

/**
 * Which sign-in methods one RELYING PARTY accepts — "everyone who reaches us comes through
 * our Entra directory", said per client rather than per issuer.
 *
 * The direction matters and is the same one `providers.ts` draws: that module holds the
 * UPSTREAMS this issuer federates to, and this one narrows, per DOWNSTREAM client, which of
 * them that client's users may arrive through. An issuer offering Microsoft, Google and
 * passwords can therefore send one vendor's staff to Microsoft alone while the next client
 * keeps all three, with no second deploy and no second issuer.
 *
 * **Stored in `oauth_client.metadata`, exactly as the theme is** (`branding.ts`), and for the
 * same three reasons: the column already exists, the admin PATCH already writes it, and — the
 * one that decides it — `clientRegistrationRequestSchema` has no `metadata` field, so dynamic
 * registration CANNOT write this. A stranger self-registering a client through
 * `allowUnauthenticatedClientRegistration` gets the default (everything) and no way to say
 * otherwise. The policy is the operator's, which is the only way it could be one.
 *
 * Absent ⇒ every method the issuer offers, so no existing client changes behaviour.
 *
 * ## What this is, and what enforces it
 *
 * The login screen drawing one button is NOT the policy. `POST /sign-in/social` takes a
 * provider id directly, and a session made any way at all resumes `/oauth2/authorize` into a
 * code. So the gate is a before-hook on `/oauth2/authorize` in `auth.ts`, which is the one
 * place the client id is authoritative, and what it reads is `session.signInProvider` — the
 * method the CURRENT session was established with, stamped at session creation by the same
 * hook block. `signInMethodOfPath` below is that stamp's whole vocabulary.
 *
 * Filtering the buttons is then what it should be: the UX half of a rule that holds anyway.
 */

/** The method id a password sign-in is stamped and matched under. */
export const PASSWORD_METHOD = 'password';

/** The method id a BankID sign-in is stamped under — minted by `bankid-plugin.ts`, not by any
 *  upstream's callback. */
export const BANKID_METHOD = 'bankid';

/**
 * The stamps that name something OTHER than an upstream provider row, and therefore may not
 * be worn by one.
 *
 * These ids are not otherwise protected, and that is the whole reason this list exists.
 * `isReservedProviderId` keeps a generic provider off Better Auth's BUILT-IN names, but
 * neither `password` nor `bankid` is a built-in social provider, so `GENERIC_ID_PATTERN`
 * happily admits both — and a generic upstream registered as `password` would land on
 * `/callback/password` and stamp its sessions with the id a password sign-in wears. A
 * password-only policy would then admit that whole upstream directory.
 *
 * Held from both ends, because they answer different rows. `admin-api.ts` refuses the id at
 * creation, which is the fix for every provider added from here on; `signInMethodOfPath`
 * refuses to READ one back off a callback path, which is the fix for a row written before
 * this list existed — such a session stamps `null` and is refused under any policy, the same
 * fail-closed answer an unstamped session gets.
 *
 * `supabase` is deliberately NOT here: `/supabase/session` stamps the id of a real catalogue
 * provider on purpose, because those sessions ARE that upstream's.
 */
export const RESERVED_METHOD_IDS: readonly string[] = [PASSWORD_METHOD, BANKID_METHOD];

/** Is this id one the stamp vocabulary owns outright (`RESERVED_METHOD_IDS`)? */
export function isReservedMethodId(id: string): boolean {
  return RESERVED_METHOD_IDS.includes(id);
}

/**
 * A client's policy, normalized. `providers: null` is "any upstream this issuer offers" and
 * is deliberately distinct from `[]`, which is "no upstream at all" — a client that accepts
 * passwords only.
 */
export interface SignInPolicy {
  providers: string[] | null;
  password: boolean;
}

/** A provider id, as `providers.ts` constrains one: the callback path segment, so path-safe. */
const methodId = z.string().regex(/^[a-z0-9](?:[a-z0-9-]{0,38}[a-z0-9])?$/);

/**
 * The stored vocabulary, v1. Both keys optional: `{ password: false }` is a complete policy
 * ("any provider, no passwords"), and so is `{ providers: ['microsoft'] }` ("Microsoft, and
 * the password form as well").
 */
const storedPolicySchema = z.object({
  providers: z.array(methodId).max(32),
  password: z.boolean(),
});

/**
 * Read an operator-written policy object into its normalized form, or `undefined` when the
 * client has no policy — which is what an absent key, a malformed one, and `{}` all mean.
 *
 * Per-key like `sanitizeTheme`, so one bad value does not discard the good ones — and then it
 * parts company with it, because a dropped key costs something different here. A dropped
 * colour is a wrong shade. A dropped half of a POLICY is a restriction that quietly stopped
 * applying, so the two halves are read apart:
 *
 *  - **Absent** is the documented default, and keeps it: no `providers` key is "any upstream",
 *    no `password` key is "the password form as well".
 *  - **Present and unreadable** normalizes to the DENY value — `[]` for `providers`, `false`
 *    for `password` — never the default. `{ providers: ['microsoft'], password: 'false' }` is
 *    a hand-written or corrupt row whose author plainly meant to deny passwords, and reading
 *    the quoted `'false'` as the permissive default would enable the one method the policy
 *    was written to refuse.
 *
 * An object with neither key is not a policy at all, which is what `{}` and `{ typo: … }`
 * both are. `assertSignInPolicy` is still the first line — an operator saving a typo is told
 * so, rather than silently getting a policy that denies more than they wrote.
 */
export function sanitizeSignInPolicy(value: unknown): SignInPolicy | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const raw = value as Record<string, unknown>;
  if (raw.providers === undefined && raw.password === undefined) return undefined;
  const providers = storedPolicySchema.shape.providers.safeParse(raw.providers);
  const password = storedPolicySchema.shape.password.safeParse(raw.password);
  return {
    providers: raw.providers === undefined ? null : providers.success ? [...new Set(providers.data)] : [],
    password: raw.password === undefined ? true : password.success && password.data,
  };
}

/**
 * The SAVE-time check, for the admin API: the policy an operator just wrote, or a thrown
 * message naming what is wrong with it. Strict where `sanitizeSignInPolicy` is permissive —
 * a typo'd key here is a restriction that would have silently not applied, and the operator
 * is standing right there and can fix it.
 */
export function assertSignInPolicy(value: unknown): SignInPolicy {
  const parsed = storedPolicySchema.partial().strict().safeParse(value);
  if (!parsed.success) {
    throw new Error(`signIn: ${parsed.error.issues.map((i) => `${i.path.join('.') || 'policy'} — ${i.message}`).join('; ')}`);
  }
  const policy: SignInPolicy = {
    providers: parsed.data.providers ? [...new Set(parsed.data.providers)] : null,
    password: parsed.data.password ?? true,
  };
  if (permitsNothing(policy)) {
    throw new Error('signIn: a policy allowing no provider and no password would lock every user out of this application');
  }
  return policy;
}

/** The policy on a client id, or `undefined` for no policy — including for a client that does
 *  not exist or is disabled, which answer alike for the reason `clientBranding` does. */
export function readSignInPolicy(sql: SqlExec, clientId: string | null | undefined): SignInPolicy | undefined {
  if (!clientId) return undefined;
  const row = sql
    .exec('SELECT metadata, disabled FROM oauth_client WHERE client_id = ?', clientId)
    .toArray()[0] as { metadata: string | null; disabled: number | null } | undefined;
  if (!row || row.disabled || !row.metadata) return undefined;
  try {
    return sanitizeSignInPolicy((JSON.parse(row.metadata) as Record<string, unknown> | null)?.signIn);
  } catch {
    return undefined;
  }
}

/**
 * May a session established through `method` be handed to this client?
 *
 * `null` — a session whose method was never stamped — is refused under any policy, and that
 * fail-closed answer is the point rather than an oversight. A stamp is missing for exactly
 * two reasons: the session predates this feature, or it was created down a path
 * `signInMethodOfPath` does not name (an administrator's impersonation, a future plugin).
 * Admitting either would make the restriction a suggestion. The cost is one re-login, which
 * the authorize hook asks for by itself.
 *
 * A client with NO policy admits everything, unstamped sessions included — nothing was
 * restricted, so there is nothing to fail closed about.
 */
export function policyAdmits(policy: SignInPolicy | undefined, method: string | null): boolean {
  if (!policy) return true;
  if (!method) return false;
  if (method === PASSWORD_METHOD) return policy.password;
  return policy.providers === null || policy.providers.includes(method);
}

/** Does this policy leave no way in at all? Refused at save time; the runtime can still meet
 *  one whose only provider was deleted afterwards, and says so on the screen instead. */
export function permitsNothing(policy: SignInPolicy): boolean {
  return !policy.password && policy.providers !== null && policy.providers.length === 0;
}

/**
 * What the login screen may draw for this client: the issuer's OWN live providers
 * (`publicProvidersFrom`, plus BankID) narrowed by the policy, and whether the password form
 * belongs on the page.
 *
 * The narrowing is an INTERSECTION, never a lookup: a policy naming `microsoft` after the
 * operator deleted that provider yields an empty list rather than a button that cannot work.
 * An empty list with `password: false` is a client nobody can sign into, and the screen says
 * that plainly — falling back to the unrestricted list would be the one behaviour that turns
 * a misconfiguration into an open door.
 */
export function effectiveSignIn(
  policy: SignInPolicy | undefined,
  issuerProviders: readonly { id: string; label: string }[],
): EffectiveSignIn {
  if (!policy) return { providers: [...issuerProviders], password: true, restricted: false };
  return {
    providers: issuerProviders.filter((p) => policy.providers === null || policy.providers.includes(p.id)),
    password: policy.password,
    restricted: true,
  };
}

/** What the signed-out login screen is told about one client. `restricted` is what lets it
 *  say "this application accepts Microsoft" rather than "this issuer offers Microsoft" — and
 *  what gates the straight-through redirect, which must never fire on the console's own
 *  unrestricted sign-in. */
export interface EffectiveSignIn {
  providers: { id: string; label: string }[];
  password: boolean;
  restricted: boolean;
}

/** The whole read for one client: the policy from the registry, intersected with what the
 *  issuer offers. Each runtime's public per-client route is one line over this. */
export function clientSignIn(
  sql: SqlExec,
  clientId: string | null | undefined,
  issuerProviders: readonly { id: string; label: string }[],
): EffectiveSignIn {
  return effectiveSignIn(readSignInPolicy(sql, clientId), issuerProviders);
}

/**
 * The method a session created while serving `path` was established with — the entire
 * vocabulary of the `session.signInProvider` stamp, in one place, read by
 * `databaseHooks.session.create.before`.
 *
 * `…/callback/:id` covers every upstream at once, catalogue and generic alike, because
 * `genericOAuth` registers its providers as first-class social providers and they all land on
 * Better Auth's one callback route (the same fact `callbackPath()` in `providers.ts` states
 * for the redirect URI an operator registers). So a provider added tomorrow is stamped
 * correctly with no change here.
 *
 * **The `path` a hook is handed is the ROUTE, not the URL** — Better Auth registers that
 * endpoint as the literal `/callback/:id` and hands the hook exactly that string, with the
 * provider in `params.id` beside it. Reading the id out of the path alone therefore stamped
 * `null` on EVERY provider sign-in, and a null is refused by every policy: a client
 * restricted to one upstream sent the person to that upstream, took their session, refused
 * it at `/oauth2/authorize`, and sent them back to the login screen that redirects — an
 * infinite loop through a working directory, and one no unit test over a hand-written
 * `/callback/microsoft` could see (#1381). So the pattern is matched as a pattern, and the
 * literal spelling is kept beside it because nothing guarantees a future route is
 * parameterized.
 *
 * Everything not named answers `null`, which `policyAdmits` refuses under any policy. Adding
 * a sign-in path to this issuer therefore means adding it here too — an omission costs a
 * re-login rather than an unenforced restriction, which is the right way round.
 */
export function signInMethodOfPath(
  path: string | undefined,
  params?: Record<string, string | undefined> | undefined,
): string | null {
  if (!path) return null;
  if (path === '/sign-in/email' || path === '/sign-up/email') return PASSWORD_METHOD;
  // BankID's session is minted in `/bankid/collect` (`bankid-plugin.ts`), the poll that sees
  // the order complete — not in `/bankid/start`, which has nobody signed in yet.
  if (path === '/bankid/collect') return BANKID_METHOD;
  // The legacy-secret bridge (`supabase-plugin.ts`). Its sessions are Supabase's, so they
  // answer to the same id the catalogue's redirect-flow Supabase provider carries.
  if (path === '/supabase/session') return 'supabase';
  // The parameter NAME is the router's, not ours (`:id`, `:providerId`), so the segment is
  // matched loosely and the value that comes back is what gets parsed strictly, below.
  const callback = /^(?:\/oauth2)?\/callback\/(:?[A-Za-z0-9_-]+)$/.exec(path);
  const segment = callback?.[1];
  if (!segment) return null;
  // `:id` ⇒ the route pattern, so the provider is the bound parameter. A pattern whose
  // parameter is absent stamps nothing rather than the word after the colon.
  const provider = segment.startsWith(':') ? params?.[segment.slice(1)] : segment;
  // Parsed with the same rule `providers.ts` constrains a provider id by: `params` is
  // whatever the router matched, and only an id-shaped value may become a stamp.
  if (!provider || !methodId.safeParse(provider).success) return null;
  // A row predating `RESERVED_METHOD_IDS` could still be named `password` or `bankid`. Its
  // callback stamps nothing rather than the stamp it collides with, and an unstamped session
  // is refused under every policy — the same answer, for the same reason, as an impersonation.
  if (isReservedMethodId(provider)) return null;
  return provider;
}
