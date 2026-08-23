/**
 * The relying-party half, for a vertical's local dev server.
 *
 * Every demo's node entrypoint needs the same two steps, and they are the two steps a
 * hosted deployment performs: verify the request against the issuer (session cookie, or a
 * bearer for a script) to get a `sub`, then ask the identity directory which principal that
 * subject is and where they live. Written once here rather than five times, for the reason
 * `@substrat-run/oidc-rp` exists — this is security-relevant glue, and five copies drift.
 *
 * What it deliberately does NOT do is decide what an unauthenticated caller means. A demo
 * answers 401; another checks whether its owner seat is unclaimed and says `needs-setup`
 * instead. That is the vertical's policy, so `caller()` simply returns null.
 *
 * The pairing with `createDevIssuer` is only a default. Point `issuer` at anything that
 * speaks OIDC and this is an ordinary relying party — which is the property the whole
 * package exists to preserve.
 */
import { oidcRpAuthProvider } from '@substrat-run/vertical-auth/oidc-rp-provider';
import type { AuthSubject } from '@substrat-run/vertical-auth/provider';
import type {
  PlatformActorId,
  PrincipalId,
  ScopeId,
  TenantId,
} from '@substrat-run/contracts';

/**
 * The slice of `HostAdmin` this needs — structural, so a dev server hands in `host.admin`
 * and nothing here depends on which adapter is underneath.
 */
export interface DevDirectory {
  listIdentityTenants(actor: PlatformActorId, provider: string, externalId: string): Promise<TenantId[]>;
  resolveIdentity(
    tenantId: TenantId,
    provider: string,
    externalId: string,
  ): Promise<{ principal: PrincipalId; scopeId: ScopeId | null } | undefined>;
}

export interface DevLoginOptions {
  /** Usually `host.admin`. */
  directory: DevDirectory;
  /** The local platform actor the directory reads are stamped with. */
  actor: PlatformActorId;
  /** The identity pool the seed linked these subjects into (e.g. `oidc:dev-issuer`). */
  provider: string;
  /** The issuer origin. Defaults to `OIDC_ISSUER`, else the dev issuer's default port. */
  issuer?: string;
  clientId?: string;
  clientSecret?: string;
  /**
   * Signs the local session cookie. Fixed by default so a reload does not sign you out —
   * it protects a localhost cookie, and being logged out on every file save buys nothing.
   */
  sessionSecret?: string;
}

export interface DevCaller {
  principal: PrincipalId;
  tenantId: TenantId;
  scopeId: ScopeId;
  /** The issuer's `sub` — what the directory was keyed on. */
  sub: string;
  /** `name`, else `email`, else the `sub`. Never empty. */
  display: string;
}

export interface DevLogin {
  /** Mount on `/api/auth/*`: login → issuer → callback → session cookie → logout. */
  handle(request: Request): Promise<Response>;
  /**
   * The verified subject behind this request — the issuer's answer, BEFORE any directory
   * lookup. Exposed for verticals whose tenant is not the directory's to choose: RallyPoint
   * resolves a caller per venue, so it knows which tenant to ask about and `caller()`'s
   * "which tenant is this login in" would be the wrong question.
   */
  subject(headers: Headers): Promise<AuthSubject | null>;
  /** The caller behind this request, or null when nobody is signed in. */
  caller(headers: Headers): Promise<DevCaller | null>;
  /** The issuer origin in use — for the boot banner. */
  issuer: string;
}

export const DEV_ISSUER_DEFAULT = 'http://localhost:8879';

export function devLogin(opts: DevLoginOptions): DevLogin {
  const issuer = opts.issuer ?? process.env.OIDC_ISSUER ?? DEV_ISSUER_DEFAULT;
  const auth = oidcRpAuthProvider({
    issuer,
    // The dev issuer registers no clients and checks no secret; a hosted instance is
    // handed real ones through `substrat:auth`. Overridable so this same harness can be
    // pointed at an issuer that does care.
    clientId: opts.clientId ?? process.env.OIDC_CLIENT_ID ?? 'substrat-dev',
    clientSecret: opts.clientSecret ?? process.env.OIDC_CLIENT_SECRET ?? 'dev-issuer-checks-no-secret',
    sessionSecret: opts.sessionSecret ?? process.env.SESSION_SECRET ?? 'substrat-local-dev-session-secret',
  });

  return {
    issuer,
    handle: (request) => auth.handle(request),
    subject: (headers) => auth.resolve(headers),
    async caller(headers) {
      const subject = await auth.resolve(headers);
      if (!subject) return null;
      // Which tenant this login exists in. A central pool, so this is a legitimate
      // question; a persona is linked in exactly one, and that link carries their scope.
      const [tenantId] = await opts.directory.listIdentityTenants(opts.actor, opts.provider, subject.sub);
      if (!tenantId) return null;
      const identity = await opts.directory.resolveIdentity(tenantId, opts.provider, subject.sub);
      if (!identity?.scopeId) return null;
      return {
        principal: identity.principal,
        tenantId,
        scopeId: identity.scopeId,
        sub: subject.sub,
        display: subject.name ?? subject.email ?? subject.sub,
      };
    },
  };
}
