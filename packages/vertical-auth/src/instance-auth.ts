import {
  DELEGATION_CHANNELS,
  SHARED_ISSUER_CONFIG_KEY,
  parsePlatformBaseDomains,
  resolveScopedEnvSpec,
  z,
  type DelegationChannel,
  type EnvVarSpec,
} from '@substrat-run/contracts';
import { issuerRefusal } from '@substrat-run/oidc-rp/discovery';
import { oidcAuthProvider, type DelegationOption } from './oidc.js';
import { oidcRpAuthProvider } from './oidc-rp-provider.js';
import type { IdentityStub } from './identity-do.js';
import type { AuthProvider } from './provider.js';
import type { RefreshStore } from './session-refresh.js';

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
  /** Accept delegated bearers from these actors (#1824) — see `InstanceDelegation`. */
  delegation?: InstanceDelegation;
  /** Keep each session's refresh token, to act for the person at a plugin (#3161) — see `OidcRpConfig.refreshStore`. */
  refreshStore?: RefreshStore;
}): Promise<InstanceAuth> {
  const wiring = await opts.directory.authWiring(opts.scopeId);
  const identity = parseAuthChoice(wiring.config[AUTH_CONFIG_KEY]);
  const settings = resolveScopedEnvSpec(opts.envSpec, opts.env, wiring.config).values;
  return {
    identity,
    sessionSecret: wiring.sessionSecret,
    settings,
    config: wiring.config,
    provider: () =>
      selectAuthProvider({
        identity,
        sessionSecret: wiring.sessionSecret,
        settings,
        sharedIssuer: wiring.config[SHARED_ISSUER_CONFIG_KEY] === 'true',
        ...(opts.delegation ? { delegation: resolveDelegation(opts.delegation, { identity, config: wiring.config }) } : {}),
        ...(opts.refreshStore ? { refreshStore: opts.refreshStore } : {}),
        platformBaseDomains: parsePlatformBaseDomains(
          typeof opts.env.PLATFORM_BASE_DOMAINS === 'string' ? opts.env.PLATFORM_BASE_DOMAINS : undefined,
        ),
      }),
  };
}

/** What a delegation's actor list may be read from (#1824): this scope's delivered configuration. */
export interface DelegationWiring {
  /** The parsed `substrat:auth` choice, or null — the issuer the actors' client ids belong to. */
  readonly identity: AuthChoice | null;
  /** The whole delivered map. */
  readonly config: Readonly<Record<string, string>>;
}

/**
 * The delegation opt-in a vertical hands `instanceAuthFor` (#1824). An actor's client id is
 * per team auth server, so one serving script answering many installs has no single list:
 * `actors` may instead be read from each install's delivered wiring, as a function.
 */
export interface InstanceDelegation {
  actors: readonly string[] | ((wiring: DelegationWiring) => readonly string[]);
  /** See `DelegationOption.maxLifetimeSeconds`. */
  maxLifetimeSeconds?: number;
  /**
   * See `DelegationOption.channels` (#3161): absent is `['mcp']`. A list, or read from each
   * install's delivered wiring like `actors`.
   */
  channels?: readonly DelegationChannel[] | ((wiring: DelegationWiring) => readonly DelegationChannel[]);
}

/**
 * The verifier's `DelegationOption` for this install. Fails CLOSED: a resolver that throws,
 * or answers anything but a list of non-empty strings, yields no actors, which admits no
 * delegated token — and leaves every other sign-in as it was. `channels` the same way: one
 * that throws or answers anything but a list of known channels yields none, which admits no
 * delegated token on either channel.
 */
function resolveDelegation(delegation: InstanceDelegation, wiring: DelegationWiring): DelegationOption {
  const actors = resolved('actors', delegation.actors, wiring);
  const listed = Array.isArray(actors) && actors.every((a) => typeof a === 'string' && a.length > 0);
  let channels: DelegationChannel[] | undefined;
  if (delegation.channels !== undefined) {
    const named = resolved('channels', delegation.channels, wiring);
    const known = Array.isArray(named) && named.every((c) => (DELEGATION_CHANNELS as readonly unknown[]).includes(c));
    channels = known ? [...(named as DelegationChannel[])] : [];
  }
  return {
    actors: listed ? [...(actors as string[])] : [],
    ...(delegation.maxLifetimeSeconds === undefined ? {} : { maxLifetimeSeconds: delegation.maxLifetimeSeconds }),
    ...(channels === undefined ? {} : { channels }),
  };
}

/** A list or the list a resolver reads from the wiring; a resolver that throws answers nothing. */
function resolved<T>(field: 'actors' | 'channels', value: T | ((wiring: DelegationWiring) => T), wiring: DelegationWiring): unknown {
  try {
    return typeof value === 'function' ? (value as (wiring: DelegationWiring) => T)(wiring) : value;
  } catch (err) {
    // The error's name only: its message may quote the delivered configuration it was reading.
    console.warn(`vertical-auth: delegation.${field} threw, so no delegated bearer is admitted`, {
      error: err instanceof Error ? err.name : typeof err,
    });
    return [];
  }
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
/**
 * Which authorization server issues access tokens for this instance (RFC 9728).
 *
 * The `authorizationServers` an MCP endpoint publishes, so a client that gets a 401 can
 * find the issuer instead of being handed a token by hand. Same question
 * `selectAuthProvider` answers, minus the provider: which issuer did this instance's
 * configuration select.
 *
 * **Never throws.** `selectAuthProvider` refuses a half-configured instance because a
 * request cannot proceed without a provider; discovery metadata is a description, and an
 * instance nobody has configured a login for truthfully has no authorization server. It
 * returns `[]`, and the document omits the field rather than naming an issuer that is
 * not there.
 *
 * It MIRRORS the precedence above — delivered `substrat:auth` first, deployment default
 * second — and `test/instance-auth.test.ts` pins the two together, because a second
 * description of one fact is only safe while something refuses to let them disagree.
 */
export function authorizationServersOf(opts: {
  identity: AuthChoice | null;
  settings: Record<string, string | undefined>;
}): string[] {
  const { identity, settings } = opts;
  // Empty for an issuer `selectAuthProvider` refuses too (`issuerRefusal`): the metadata must
  // not send a client to an authorization server this instance will not talk to.
  const named = (issuer: string | undefined): string[] => (issuer && issuerRefusal(issuer) === null ? [issuer] : []);
  if (identity?.mode === 'oidc') return named(identity.issuer);
  if (settings.AUTH_PROVIDER === 'oidc') return named(settings.OIDC_ISSUER);
  return [];
}

export function selectAuthProvider(opts: {
  identity: AuthChoice | null;
  sessionSecret: string;
  settings: Record<string, string | undefined>;
  /**
   * The delivered `SHARED_ISSUER_CONFIG_KEY`: the `substrat:auth` issuer is a team
   * auth-server, so a bearer must be this app's own (#1683). Applies to the delivered
   * choice only — the deployment default's issuer is the operator's own.
   */
  sharedIssuer?: boolean;
  /**
   * Accept delegated bearers from these actors at this app's MCP endpoint (#1824). Applies to
   * the delivered choice on a shared issuer only: a team auth server is the issuer that mints
   * them. Absent, every bearer carrying `act` is refused.
   */
  delegation?: DelegationOption;
  /** Keep each session's refresh token (#3161). Applies to the delivered choice only, which is the one with a login. */
  refreshStore?: RefreshStore;
  platformBaseDomains?: readonly string[];
}): AuthProvider {
  const { identity, settings } = opts;
  if (identity?.mode === 'oidc') {
    if (!identity.issuer || !identity.clientId) {
      throw new AuthConfigError(
        503,
        "this instance's OIDC configuration is incomplete — set issuer and clientId",
      );
    }
    // Refused HERE, loudly, and not in the schema above: a schema refusal reads as "nothing
    // delivered" and the instance would quietly run the deployment's default identity provider
    // instead. The relying party sends its client secret to this issuer, so it is https (or a
    // loopback dev issuer) or the instance answers 503.
    const refused = issuerRefusal(identity.issuer);
    if (refused) throw new AuthConfigError(503, `this instance's OIDC issuer is refused: ${refused}`);
    return oidcRpAuthProvider({
      issuer: identity.issuer,
      clientId: identity.clientId,
      clientSecret: identity.clientSecret ?? '',
      sessionSecret: opts.sessionSecret,
      ...(identity.audience ? { audience: identity.audience } : {}),
      ...(identity.cookieDomain ? { cookieDomain: identity.cookieDomain } : {}),
      ...(opts.sharedIssuer ? { sharedIssuer: true } : {}),
      ...(opts.delegation ? { delegation: opts.delegation } : {}),
      ...(opts.refreshStore ? { refreshStore: opts.refreshStore } : {}),
      platformBaseDomains: opts.platformBaseDomains,
    });
  }
  if (settings.AUTH_PROVIDER === 'oidc') {
    if (!settings.OIDC_ISSUER) {
      throw new AuthConfigError(500, 'AUTH_PROVIDER=oidc but OIDC_ISSUER is unset');
    }
    const refused = issuerRefusal(settings.OIDC_ISSUER);
    if (refused) throw new AuthConfigError(503, `this instance's OIDC issuer is refused: ${refused}`);
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
