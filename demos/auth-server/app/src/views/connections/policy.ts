/**
 * The sign-in policy arithmetic behind a connection's Applications tab — what "enabled" reads
 * as, and what a toggle writes. Split from `model.ts` and typed structurally so it imports
 * nothing: the issuer's node suite tests it (`test/console-connections.test.ts`), and that
 * program cannot compile the browser API module `model.ts` takes its types from.
 */

/** The reserved id the password database is stamped under (`src/sign-in-policy.ts`). */
export const DATABASE_ID = 'password' as const;

/** The one part of a registered client this module reads. */
export interface PolicyHolder {
  metadata?: Record<string, unknown>;
}

/**
 * A client's stored policy, read the way `sanitizeSignInPolicy` reads it on the server: an
 * absent key is its permissive default, and a present-but-unreadable one is the DENY value —
 * so this screen never shows a connection as enabled that the authorize hook would refuse.
 * `null` is "no policy", which admits every connection.
 */
interface ReadPolicy {
  /** `null` = every upstream the issuer offers. */
  providers: string[] | null;
  password: boolean;
  domainRoutes: { domains: string[]; provider: string }[];
}

const POLICY_KEYS = ['providers', 'password', 'passwordSecondFactor', 'identifierFirst', 'domainRoutes'];

function storedPolicy(client: PolicyHolder): Record<string, unknown> | null {
  const raw = client.metadata?.signIn;
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const policy = raw as Record<string, unknown>;
  return POLICY_KEYS.some((k) => policy[k] !== undefined) ? policy : null;
}

function readPolicy(client: PolicyHolder): ReadPolicy | null {
  const raw = storedPolicy(client);
  if (!raw) return null;
  const providers =
    raw.providers === undefined
      ? null
      : Array.isArray(raw.providers) && raw.providers.every((p) => typeof p === 'string')
        ? (raw.providers as string[])
        : [];
  const password = raw.password === undefined ? true : raw.password === true;
  const domainRoutes = Array.isArray(raw.domainRoutes)
    ? (raw.domainRoutes as { domains?: unknown; provider?: unknown }[])
        .filter((r) => typeof r.provider === 'string' && Array.isArray(r.domains))
        .map((r) => ({ domains: (r.domains as unknown[]).filter((d): d is string => typeof d === 'string'), provider: r.provider as string }))
    : [];
  return { providers, password, domainRoutes };
}

/**
 * Is this connection open to everyone signing into `client`? A domain route is deliberately not
 * counted: it offers a provider to some addresses only, and it is edited on the application
 * (its rules have an order and a lock), so the switch here neither reads nor writes it.
 */
export function enabledFor(client: PolicyHolder, connectionId: string): boolean {
  const policy = readPolicy(client);
  if (!policy) return true;
  if (connectionId === DATABASE_ID) return policy.password;
  return policy.providers === null || policy.providers.includes(connectionId);
}

/** Does this client follow every upstream the issuer offers, including ones added later? */
export function followsEveryUpstream(client: PolicyHolder): boolean {
  return readPolicy(client)?.providers == null;
}

/** The email domains this client routes to the connection, if any. */
export function routedDomains(client: PolicyHolder, connectionId: string): string[] {
  return (readPolicy(client)?.domainRoutes ?? []).filter((r) => r.provider === connectionId).flatMap((r) => r.domains);
}

/**
 * The whole `metadata` to PATCH for "this connection on/off for this client". Every other
 * metadata key — and every other policy key (SMS, identifier-first, domain routes) — is
 * carried through as stored: the switch owns one entry in one list, nothing else.
 *
 * Turning an upstream OFF for a client with no `providers` list has to WRITE one, made of
 * every other upstream the issuer offers right now, because "every upstream but this one" has
 * no stored spelling. That pins the client: an upstream added afterwards is no longer enabled
 * for it automatically. The screen says so before the switch is pressed.
 *
 * Throws when it would need `offered` and does not have it — an empty list there would store
 * "no upstreams at all", which is a policy nobody chose.
 */
export function toggledMetadata(
  client: PolicyHolder,
  connectionId: string,
  on: boolean,
  offered: readonly { id: string }[] | null,
): Record<string, unknown> {
  const metadata: Record<string, unknown> = { ...(client.metadata ?? {}) };
  const policy: Record<string, unknown> = { ...(storedPolicy(client) ?? {}) };
  const read = readPolicy(client);

  if (connectionId === DATABASE_ID) {
    // On is the default, so it is written as the key's absence rather than `true`.
    if (on) delete policy.password;
    else policy.password = false;
  } else if (read?.providers == null) {
    // Following every upstream already includes this one; only OFF changes anything.
    if (!on) {
      if (!offered) throw new Error('The issuer’s offered connections have not loaded yet, so this client cannot be pinned to a list of them. Try again in a moment.');
      policy.providers = offered.map((p) => p.id).filter((id) => id !== connectionId && id !== DATABASE_ID);
    }
  } else {
    const rest = read.providers.filter((id) => id !== connectionId);
    policy.providers = on ? [...rest, connectionId] : rest;
  }

  // A policy left with nothing in it is no policy, and absent is the documented default —
  // a stored `{}` would read the same today and is one more thing to explain tomorrow.
  if (POLICY_KEYS.some((k) => policy[k] !== undefined)) metadata.signIn = policy;
  else delete metadata.signIn;
  return metadata;
}
