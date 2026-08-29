import { resolveScopedEnvSpec, z, type EnvVarSpec } from '@substrat-run/contracts';
import { oidcAuthProvider } from './oidc.js';
import { oidcRpAuthProvider } from './oidc-rp-provider.js';
import type { IdentityStub } from './identity-do.js';
import type { AuthProvider } from './provider.js';

/**
 * ONE instance's auth wiring — the composition every OIDC-only vertical was writing
 * for itself (#972).
 *
 * Four demos carried a near-identical forty-line copy of "read the delivered config,
 * parse `substrat:auth`, resolve the declared settings, pick a provider", and they had
 * already drifted: manyfold's copy skipped `resolveScopedEnvSpec` entirely and read
 * `env.OIDC_ISSUER`, so a per-instance issuer saved in the dashboard never reached it
 * (the silent-defaults bug, #374/#398); meridian's fail-closed check on an unset issuer
 * existed only in meridian. A rule that lives in four places is four chances to be
 * wrong about it once. It lives here now.
 */

/**
 * The scope's DELIVERED auth choice (vertical-auth-detach.md §2.2/§2.3) — the
 * `substrat:auth` entry the dashboard configured at install or in Settings.
 *
 * OIDC-only (oidc-only-demos.md): `oidc` is the only supported mode, so a `builtin` or
 * malformed entry fails this parse and reads as "nothing delivered". That leniency is
 * deliberate — a bad delivery falls back to the deployment default rather than locking
 * an instance out of its own login.
 */
export const authChoice = z.object({
  mode: z.literal('oidc'),
  issuer: z.string().url().optional(),
  clientId: z.string().min(1).optional(),
  clientSecret: z.string().optional(),
  audience: z.string().optional(),
  /** Share the login across every surface under this parent domain (K-26 multi-surface). */
  cookieDomain: z.string().min(1).optional(),
});

export type AuthChoice = z.infer<typeof authChoice>;

/** The delivered-config key the dashboard writes the identity choice to. */
export const AUTH_CONFIG_KEY = 'substrat:auth';

/**
 * An instance that cannot be given a provider, with the status to answer.
 *
 * A plain `Error` would arrive at a vertical's error envelope as a 500, which is the
 * wrong answer for "nobody has configured this yet" — so the status travels with the
 * throw and each worker re-raises it in its own framework's exception.
 */
export class AuthConfigError extends Error {
  constructor(
    readonly status: 500 | 503,
    message: string,
  ) {
    super(message);
    this.name = 'AuthConfigError';
  }
}

export interface InstanceAuth {
  /** The parsed `substrat:auth` choice, or null when nothing usable was delivered. */
  identity: AuthChoice | null;
  /** The tenant's DO-minted session-signing secret. */
  sessionSecret: string;
  /** The declared settings, resolved delivered > binding > manifest default (#398). */
  settings: Record<string, string | undefined>;
  /** The whole delivered map — for a vertical's own non-declared keys. */
  config: Record<string, string>;
  /**
   * The `AuthProvider` this instance's configuration selects. A function, not a field:
   * a route that only wants `settings` must not fail because nobody has configured a
   * login yet. Throws `AuthConfigError` when there is nothing to select.
   */
  provider(): AuthProvider;
}

/**
 * Everything an instance was configured with, in ONE DO hop.
 *
 * `settings` comes from `resolveScopedEnvSpec` over the SAME delivered map the auth
 * choice rides in — no second round-trip, and per-scope Env-tab value > worker binding >
 * manifest default. Reading `env` directly instead is the bug this replaces: a spec
 * `default` rides as a binding shared by every install of one serving script, so
 * `env.OIDC_ISSUER` is the same string for every tenant no matter what any of them saved.
 */
export async function instanceAuthFor(opts: {
  /** The tenant's identity DO stub. */
  directory: Pick<IdentityStub, 'authWiring'>;
  scopeId: string;
  /** The vertical's declared env spec (`CALLOUT_ENV`, `TICKET0_ENV`, …). */
  envSpec: EnvVarSpec[];
  /** The worker's own environment — the binding layer under the delivered map. */
  env: Record<string, unknown>;
}): Promise<InstanceAuth> {
  const wiring = await opts.directory.authWiring(opts.scopeId);
  const identity = parseAuthChoice(wiring.config[AUTH_CONFIG_KEY]);
  const settings = resolveScopedEnvSpec(opts.envSpec, opts.env, wiring.config).values;
  return {
    identity,
    sessionSecret: wiring.sessionSecret,
    settings,
    config: wiring.config,
    provider: () => selectAuthProvider({ identity, sessionSecret: wiring.sessionSecret, settings }),
  };
}

/** The delivered `substrat:auth` entry, parsed leniently: anything unusable is null. */
export function parseAuthChoice(raw: string | undefined): AuthChoice | null {
  if (!raw) return null;
  try {
    const parsed = authChoice.safeParse(JSON.parse(raw));
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}

/**
 * The provider an instance's configuration selects — the whole point of the contract.
 *
 * Per-SCOPE first (hosted): a delivered `substrat:auth` builds the full relying-party
 * provider (browser login at the issuer, cookie sessions signed with the tenant's
 * DO-minted secret, bearer fallback for API clients) — one script, many issuers.
 * Absent that, the DEPLOYMENT default: `AUTH_PROVIDER=oidc` verifies bearer tokens
 * against a fixed issuer (standalone deploys). Anything else is unconfigured — fail
 * closed. The app never learns which; it only ever holds an `AuthProvider`.
 *
 * `AUTH_PROVIDER=oidc` with no `OIDC_ISSUER` is a 500, not a 503: the deployment asked
 * for a provider it did not finish configuring, which is an operator's mistake, not a
 * tenant's missing choice.
 */
export function selectAuthProvider(opts: {
  identity: AuthChoice | null;
  sessionSecret: string;
  settings: Record<string, string | undefined>;
}): AuthProvider {
  const { identity, settings } = opts;
  if (identity?.mode === 'oidc') {
    if (!identity.issuer || !identity.clientId) {
      throw new AuthConfigError(
        503,
        "this instance's OIDC configuration is incomplete — set issuer and clientId",
      );
    }
    return oidcRpAuthProvider({
      issuer: identity.issuer,
      clientId: identity.clientId,
      clientSecret: identity.clientSecret ?? '',
      sessionSecret: opts.sessionSecret,
      ...(identity.audience ? { audience: identity.audience } : {}),
      ...(identity.cookieDomain ? { cookieDomain: identity.cookieDomain } : {}),
    });
  }
  if (settings.AUTH_PROVIDER === 'oidc') {
    if (!settings.OIDC_ISSUER) {
      throw new AuthConfigError(500, 'AUTH_PROVIDER=oidc but OIDC_ISSUER is unset');
    }
    return oidcAuthProvider({
      issuer: settings.OIDC_ISSUER,
      ...(settings.OIDC_AUDIENCE ? { audience: settings.OIDC_AUDIENCE } : {}),
    });
  }
  throw new AuthConfigError(
    503,
    "this instance has no identity provider configured — deliver substrat:auth with mode 'oidc', or set AUTH_PROVIDER=oidc and OIDC_ISSUER",
  );
}
