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
import { HTTPException } from 'hono/http-exception';
import { oidcRpAuthProvider, verifiedEmailOf } from '@substrat-run/vertical-auth/oidc-rp-provider';
import type { DelegationOption } from '@substrat-run/vertical-auth/oidc';
import type { AuthSubject } from '@substrat-run/vertical-auth/provider';
import { DelegatedTokenError, delegatedToken, type DelegatedTokenDeps } from '@substrat-run/vertical-auth/delegate';
import { SESSION_REFRESH_DDL, sqlRefreshStore, type RefreshStore } from '@substrat-run/vertical-auth/session-refresh';
import { DEV_CLIENT_ID } from './issuer.js';
import type { DevSqliteDatabase } from './member-invites.js';
import {
  PEER_CLIENT_OPERATION,
  peerClientAnswer,
  type PlatformActorId,
  type PrincipalId,
  type ScopeId,
  type TenantId,
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
  /**
   * A subject no link names yet, admitted by a member invite naming the address their issuer
   * verified (K-61 phase 3) — `devMemberInvites(…).admit`. Asked once per request from such a
   * subject; a subject it admits is linked in the pool, so the next request resolves as anyone does.
   */
  admit?: (sub: string, verifiedEmail: string | null) => Promise<{ principal: PrincipalId; tenantId: TenantId; scopeId: ScopeId } | null>;
  /**
   * Keep each session's refresh token (#3161), so this app can call a plugin as the person
   * signed in (`devDelegate`) — `devRefreshStore(…)`. Login then asks for `offline_access`.
   */
  refreshStore?: RefreshStore;
  /**
   * The apps this one lets act for its people (#3161): a plugin names its master's client here,
   * with `channels: ['peer']`, and `resolveOnBehalf` admits the tokens that master obtains.
   */
  delegation?: DelegationOption;
}

export interface DevCaller {
  principal: PrincipalId;
  tenantId: TenantId;
  scopeId: ScopeId;
  /** The issuer's `sub` — what the directory was keyed on. */
  sub: string;
  /** `name`, else `email`, else the `sub`. Never empty. */
  display: string;
  /** The issuer's `email` claim, or null when it sent none. */
  email: string | null;
  /** What the door hands `getScope` as `verifiedEmail` (K-61). */
  verifiedEmail: string | null;
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
  /**
   * The person a peer call is made for (#3161): the provider's `resolveOnBehalf`, which admits
   * only a `peer`-channel token minted for this client by an actor `delegation` names.
   */
  resolveOnBehalf(token: string): Promise<AuthSubject | null>;
  /** The issuer origin in use — for the boot banner. */
  issuer: string;
  /** This app's OIDC client at the issuer: the `aud` of its sign-ins, the actor of its delegations. */
  clientId: string;
}

export const DEV_ISSUER_DEFAULT = 'http://localhost:8879';

/** What the dev issuer is handed as a client secret: it registers no clients and checks none. */
const DEV_CLIENT_SECRET = 'dev-issuer-checks-no-secret';

export function devLogin(opts: DevLoginOptions): DevLogin {
  const issuer = opts.issuer ?? process.env.OIDC_ISSUER ?? DEV_ISSUER_DEFAULT;
  const clientId = opts.clientId ?? process.env.OIDC_CLIENT_ID ?? DEV_CLIENT_ID;
  const auth = oidcRpAuthProvider({
    issuer,
    // The dev issuer registers no clients and checks no secret; a hosted instance is
    // handed real ones through `substrat:auth`. Overridable so this same harness can be
    // pointed at an issuer that does care.
    clientId,
    clientSecret: opts.clientSecret ?? process.env.OIDC_CLIENT_SECRET ?? DEV_CLIENT_SECRET,
    sessionSecret: opts.sessionSecret ?? process.env.SESSION_SECRET ?? 'substrat-local-dev-session-secret',
    // Held to the rule a hosted vertical on a team auth-server is held to (#1683): a bearer
    // must be this app's own — `/dev/token`'s default audience, or an MCP token for this
    // origin's endpoint — so a script that works here works there.
    sharedIssuer: true,
    ...(opts.refreshStore ? { refreshStore: opts.refreshStore } : {}),
    ...(opts.delegation ? { delegation: opts.delegation } : {}),
  });

  return {
    issuer,
    clientId,
    handle: (request) => auth.handle(request),
    subject: (headers) => auth.resolve(headers),
    resolveOnBehalf: (token) => auth.resolveOnBehalf(token),
    async caller(headers) {
      const subject = await auth.resolve(headers);
      if (!subject) return null;
      const verifiedEmail = verifiedEmailOf(subject);
      // Which tenant this login exists in. A central pool, so this is a legitimate
      // question; a persona is linked in exactly one, and that link carries their scope.
      const [tenantId] = await opts.directory.listIdentityTenants(opts.actor, opts.provider, subject.sub);
      const identity = tenantId ? await opts.directory.resolveIdentity(tenantId, opts.provider, subject.sub) : undefined;
      const home = tenantId && identity?.scopeId
        ? { principal: identity.principal, tenantId, scopeId: identity.scopeId }
        : tenantId
          ? null
          : ((await opts.admit?.(subject.sub, verifiedEmail)) ?? null);
      if (!home) return null;
      return {
        ...home,
        sub: subject.sub,
        display: subject.name ?? subject.email ?? subject.sub,
        email: subject.email,
        verifiedEmail,
      };
    },
  };
}

/**
 * Where a master's dev server keeps each session's refresh token (#3161): `session_refresh` in a
 * SQLite file of its own, as `devPeople` keeps its answers. Hand it to `devLogin` and `devDelegate`.
 */
export function devRefreshStore(db: DevSqliteDatabase): RefreshStore {
  for (const stmt of SESSION_REFRESH_DDL) db.exec(stmt);
  return sqlRefreshStore({
    exec(query, ...params) {
      const stmt = db.prepare(query);
      if (stmt.reader) return stmt.all(...params) as Record<string, unknown>[];
      stmt.run(...params);
      return [];
    },
  });
}

/** The slice of the local broker's client `devDelegate` calls through: one scope of the master. */
export interface DevPeerClient {
  invoke<O = unknown>(
    target: string,
    operation: string,
    input?: unknown,
    options?: { onBehalf?: { token: string }; idempotencyKey?: string },
  ): Promise<O>;
}

export interface DevDelegateOptions {
  /** The master's `devLogin(…)`, built with `refreshStore`. */
  login: Pick<DevLogin, 'subject' | 'issuer' | 'clientId'>;
  /** The store `login` keeps refresh tokens in. */
  store: RefreshStore;
  /** This client's secret at the issuer. The dev issuer checks none, so the default is a placeholder. */
  clientSecret?: string;
  /** `broker.clientFor(<the master's scope>)`. */
  peer: DevPeerClient;
}

export interface DevDelegate {
  /**
   * Call `operation` on the master's instance of plugin `vertical` as the person signed in on
   * `headers`. Throws an `HTTPException`: 401 when nobody is signed in or the session cannot act
   * for them (signed in before refresh tokens were kept, or the issuer refused the one kept; sign
   * in again), 403 when the issuer will not delegate to that plugin or it signs nobody in, 503
   * when the issuer could not be reached. The plugin's own refusals come through as it threw them.
   */
  invoke<O = unknown>(
    headers: Headers,
    vertical: string,
    operation: string,
    input?: unknown,
    options?: { scope?: readonly string[]; idempotencyKey?: string },
  ): Promise<O>;
}

const DELEGATED_STATUS = { reauth: 401, refused: 403, unavailable: 503 } as const;

/**
 * The master's side of a call to its plugin as the signed-in person, on a dev server (#3161):
 * the session's refresh token buys a live token of the person, which the dev issuer exchanges for
 * one addressed to the plugin's client, and the local broker carries the call with it. A token is
 * obtained for every call and used at once, so none is held between calls.
 */
export function devDelegate(opts: DevDelegateOptions): DevDelegate {
  const deps: DelegatedTokenDeps = {
    issuer: opts.login.issuer,
    clientId: opts.login.clientId,
    clientSecret: opts.clientSecret ?? process.env.OIDC_CLIENT_SECRET ?? DEV_CLIENT_SECRET,
    store: opts.store,
    // The global looked up at call time, called as a plain function.
    fetch: (input, init) => globalThis.fetch(input, init as RequestInit),
  };
  /** Each plugin's client id, once it has answered with one. */
  const clients = new Map<string, string>();
  const clientOf = async (vertical: string): Promise<string> => {
    const known = clients.get(vertical);
    if (known !== undefined) return known;
    const { clientId } = peerClientAnswer.parse(await opts.peer.invoke(vertical, PEER_CLIENT_OPERATION));
    if (clientId === null) throw new HTTPException(403, { message: `'${vertical}' signs nobody in, so it takes no calls made for a person` });
    clients.set(vertical, clientId);
    return clientId;
  };

  return {
    async invoke<O>(
      headers: Headers,
      vertical: string,
      operation: string,
      input?: unknown,
      options: { scope?: readonly string[]; idempotencyKey?: string } = {},
    ): Promise<O> {
      const subject = await opts.login.subject(headers);
      if (!subject) throw new HTTPException(401, { message: 'unauthorized' });
      if (!subject.sid) {
        throw new HTTPException(401, { message: 'sign in again: this session was started before it could act for you elsewhere' });
      }
      const audience = await clientOf(vertical);
      let token: string;
      try {
        ({ token } = await delegatedToken(deps, {
          sid: subject.sid,
          audience,
          ...(options.scope ? { scope: options.scope } : {}),
        }));
      } catch (error) {
        if (!(error instanceof DelegatedTokenError)) throw error;
        throw new HTTPException(DELEGATED_STATUS[error.kind], { message: error.message, cause: error });
      }
      return opts.peer.invoke<O>(vertical, operation, input, {
        onBehalf: { token },
        ...(options.idempotencyKey === undefined ? {} : { idempotencyKey: options.idempotencyKey }),
      });
    },
  };
}
