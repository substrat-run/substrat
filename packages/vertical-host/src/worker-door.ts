/**
 * The door a deployed vertical's worker mounts: who is calling, and the routes that decide it.
 *
 * A vertical runs no credential store. Sign-in is the issuer's, the subject maps to a principal in
 * the tenant's identity directory, and the first person in takes the owner seat. Every deployed
 * worker carried that wiring by hand, and a project should not hold it: the template shipped none,
 * so a generated app answered 401 to everybody once hosted. So it lives here once, and a worker
 * supplies only what is its own: its bindings, how a request routes, and its declared settings.
 *
 * `scope` is the one way in. It hands `getScope` the address the issuer verified (K-61), so an
 * operation reads `ctx.verifiedEmail` and a worker cannot forget to pass it.
 *
 * It is also where a person arrives. The first time someone signed in reaches a scope, the door
 * runs the vertical's join, if it names one, and then gives them every shape its `permissions`
 * declare `bootstrap` with `holder: 'self'`, on their own record (`grantSelfShapesLocal`). A dev
 * server's seed does both; a deployed worker had nothing that did, so a hosted owner could sign in
 * and then not create anything. Both run again in a new isolate, and both are made safe to: a
 * join returns the row it already wrote, and a shape is given once, so a revoke stays revoked.
 *
 * On its own subpath because `IdentityDO` is a Durable Object: `cloudflare:workers` does not load
 * in the node server a vertical's dev loop runs, which imports this package's root.
 *
 * It admits an invited person too (K-61 phase 3). Someone signed in and bound to nobody in the scope,
 * whose issuer verified an address an open member invite names, is bound to that invite's principal
 * on their first request (`admitByAddress`), and then arrives as anyone does. No link is involved:
 * the address is the proof, as strong as the issuer's `email_verified`.
 *
 * And, when the worker names its `invites`, it mounts the two routes that make one:
 *
 *   POST /api/member-invites                     { email, roleKey } → 201 { principal, email, roleKey, expiresAt }
 *   POST /api/member-invites/:principal/withdraw                    → 204
 *
 * The invited principal and its role (bounded by the inviter's own) and a link that expires are
 * minted first. Then the vertical's own operation runs as the inviter: it decides who may invite,
 * records what its screens show, and queues the mail, which carries no secret. Only after it agrees
 * is the invite recorded where the door looks, so nobody is admitted by an invite the vertical
 * refused; a refusal takes the rest back. A withdrawal takes the platform's half first, bounded by
 * the roles the invited principal holds, so no later failure leaves an invite that still admits; the
 * vertical's operation then updates its own record. Listing is the vertical's own read.
 *
 * A worker that hands out invite LINKS instead mounts `mountInviteRoutes` beside this, with its own
 * admin gate; an invite naming an address is accepted there only by a verified holder of it.
 */
import type { Context, Hono } from 'hono';
import { HTTPException } from 'hono/http-exception';
import {
  instant,
  principalId,
  z,
  type BoundedBecomeMint,
  type BoundedBecomeRevoke,
  type CapabilityExchange,
  type CapabilityId,
  type Coverage,
  type EntityRef,
  type EnvVarSpec,
  type Instant,
  type PrincipalBecomeCapabilityInput,
  type PrincipalId,
  type ScopeId,
  type TenantId,
} from '@substrat-run/contracts';
import type { ScopeHost, ScopeStub, ScopeStubOptions } from '@substrat-run/kernel';
import {
  AuthConfigError,
  IdentityDO,
  instanceAuthFor,
  mintOwnerClaimLink,
  placesReporter,
  reportScopeMembers,
  verifiedEmailOf,
  type AuthProvider,
  type AuthSubject,
  type IdentityStub,
  type InstanceAuth,
  type OwnerClaimMintHost,
} from '@substrat-run/vertical-auth';
import {
  MEMBER_INVITE_TTL_MS,
  admitByAddress,
  bodyOf,
  mintMemberInvite,
  uncovered,
  withdrawMemberInvite,
} from '@substrat-run/vertical-auth/invite-routes';
import { mountOwnerClaim, type OwnerClaimRouteDeps } from '@substrat-run/vertical-auth/owner-claim-routes';
import { mountSession, sessionAnswer } from '@substrat-run/vertical-auth/session-route';
import type { PlatformSurfaceDeps } from './index.js';

export { IdentityDO };

/** The (tenant, scope) a request routed to. */
export interface DoorNode {
  tenantId: TenantId;
  scopeId: ScopeId;
}

/** What a worker supplies: only what is its own. */
export interface WorkerDoorDeps<E extends object> {
  /** The tenant's identity directory: `env.AUTH.get(env.AUTH.idFromName(node.tenantId))`. */
  directory: (env: E, node: DoorNode) => IdentityStub;
  /** The routed (tenant, scope), from the router's assertion. */
  nodeFor: (req: Request, env: E) => DoorNode;
  hostFor: (env: E) => Pick<ScopeHost, 'getScope'> & OwnerClaimMintHost & ReturnType<OwnerClaimRouteDeps<E, DoorNode>['host']> & SelfShapeHost & DoorInviteHost;
  /** The vertical's declared settings, resolved per scope with the delivered values. */
  envSpec: EnvVarSpec[];
  /**
   * The vertical's join, if it has one: `(scope, who) => scope.invoke('todo/join', { displayName:
   * who.display })`. Run when a person first reaches a scope, and only when the issuer verified
   * their address, since a join records it from `ctx.verifiedEmail`. Their own-record shapes are
   * given after it succeeds. A refusal is logged and tried again on their next request.
   *
   * It can run more than once for one person (a new isolate, two first requests at once), so the
   * join has to return the row it already wrote rather than fail, as `todo/join` does.
   */
  join?: (scope: ScopeStub, who: { display: string }) => Promise<unknown>;
  /**
   * Member invites through the door (K-61 phase 3): the two routes above, and the vertical's own
   * operations they run as the caller. Omit it and neither route is mounted; a person a member
   * invite names (made by the dashboard, say) is still admitted by their verified address.
   */
  invites?: DoorInvites;
}

/** What a worker names to let its people invite by address through the door. */
export interface DoorInvites {
  /** The roles a person may be invited at — the vertical's own, as the dashboard's member roles are. */
  roles: readonly string[];
  /**
   * The vertical's invite, as the inviter, once the invited principal holds its role and before
   * anything can admit by it: it checks who may invite, records what its screens list, and queues
   * the mail — "sign in with this address", with no link to carry.
   * `(scope, i) => scope.invoke('crm/invite-member', { email: i.email, roleKey: i.roleKey })`.
   * A throw takes the platform's half back and is the route's answer.
   *
   * It must not grant anything to `invitation.principal`. The invite's link is judged against what
   * that principal held when it was minted, so a grant made here revokes it, and the person is
   * answered 401 at sign-in. What they hold comes from the role, and from the vertical's join.
   */
  send: (scope: ScopeStub, invitation: DoorInvitation & { email: string; expiresAt: Instant }) => Promise<unknown>;
  /**
   * The vertical's withdrawal, as the caller, once the platform's half is taken: its own record.
   * Also run when the invite's row could not be written after `send` agreed. `email` is null for an
   * invite the dashboard made without one. A throw is the route's answer; the invite is gone by then.
   */
  cancel: (scope: ScopeStub, invitation: DoorInvitation) => Promise<unknown>;
}

/** An open member invite, as the vertical's operations are told about it. */
export interface DoorInvitation {
  /** The invited principal: the one the person is bound to, and the one a withdrawal names. */
  principal: PrincipalId;
  email: string | null;
  roleKey: string;
}

/** The host call that gives a person the shapes declared for their own record. */
export interface SelfShapeHost {
  grantSelfShapesLocal(scopeId: ScopeId, principal: PrincipalId): Promise<EntityRef[]>;
}

/**
 * The host verbs admission and the invite routes run (K-61 phase 3) — the scope's own, bounded
 * where a person is the one asking. `CloudflareScopeHost` has every one.
 */
export interface DoorInviteHost {
  exchangeBecomeLinkById(tenantId: TenantId, scopeId: ScopeId, capabilityId: CapabilityId): Promise<CapabilityExchange | null>;
  assignScopeRoleBounded(
    tenantId: TenantId, scopeId: ScopeId, caller: PrincipalId, assignee: PrincipalId, roleKey: string,
  ): Promise<Coverage>;
  revokeScopeRole(scopeId: ScopeId, principal: PrincipalId, roleKey: string): Promise<unknown>;
  revokeScopeRolesBounded(
    tenantId: TenantId, scopeId: ScopeId, caller: PrincipalId, principal: PrincipalId,
  ): Promise<{ coverage: Coverage; revoked: string[] }>;
  mintBecomeCapabilityBounded(
    tenantId: TenantId, scopeId: ScopeId, caller: PrincipalId, input: PrincipalBecomeCapabilityInput,
  ): Promise<BoundedBecomeMint>;
  revokeBecomeCapability(tenantId: TenantId, scopeId: ScopeId, capabilityId: CapabilityId, by: PrincipalId): Promise<BoundedBecomeRevoke>;
}

/** The body `POST /api/member-invites` takes: an address is required, since it is what admits. */
const memberInviteBody = z.object({ email: z.string().email(), roleKey: z.string().min(1) });

type DoorHooks<E> = Required<
  Pick<
    PlatformSurfaceDeps<E>,
    | 'onProvision'
    | 'onConfigure'
    | 'onReadPreviewConfig'
    | 'onDeleteScope'
    | 'resolveOwner'
    | 'ownerSeat'
    | 'mintOwnerClaim'
    | 'transferOwner'
    | 'completeOwnerTransfer'
    | 'abandonOwnerTransfer'
  >
>;

export interface WorkerDoor<E extends object> {
  /** `/api/auth/*` (the login round-trip), `/api/me`, `/api/claim-owner`, and `/api/member-invites*` when `invites` is named. */
  mount(app: Hono<{ Bindings: E }>): void;
  /** The caller's scope stub, with their verified address. 401 for nobody. */
  scope(c: Context<{ Bindings: E }>, options?: ScopeStubOptions): Promise<ScopeStub>;
  /**
   * The declared settings for one scope: delivered value, then binding, then default. Read them
   * here and never off `env`: a default rides as a binding every install of a script shares.
   */
  settings(env: E, node: DoorNode): Promise<InstanceAuth['settings']>;
  /** Spread into `mountPlatformSurface`, so what the platform delivers lands in the directory. */
  platform: DoorHooks<E>;
}

export function workerDoor<E extends object>(deps: WorkerDoorDeps<E>): WorkerDoor<E> {
  const wiring = (env: E, node: DoorNode): Promise<InstanceAuth> =>
    instanceAuthFor({
      directory: deps.directory(env, node),
      scopeId: node.scopeId,
      envSpec: deps.envSpec,
      env: env as unknown as Record<string, unknown>,
    });

  /** The provider a configuration selects; a refusal is its HTTP status, not a 500. */
  const providerOf = (instance: InstanceAuth): AuthProvider => {
    try {
      return instance.provider();
    } catch (err) {
      if (err instanceof AuthConfigError) throw new HTTPException(err.status, { message: err.message });
      throw err;
    }
  };
  const authProvider = async (env: E, req: Request): Promise<AuthProvider> =>
    providerOf(await wiring(env, deps.nodeFor(req, env)));

  /**
   * The people who have arrived, per isolate. Arriving is safe to repeat, so this only saves the
   * calls; it is cleared rather than left to grow.
   */
  const arrived = new Set<string>();
  const arrive = async (env: E, node: DoorNode, principal: PrincipalId, subject: AuthSubject, scope: ScopeStub) => {
    const key = `${node.tenantId}/${node.scopeId}/${principal}`;
    if (arrived.has(key)) return;
    if (deps.join) {
      // Not yet a person here: they are signed in, and they join once the issuer vouches.
      if (verifiedEmailOf(subject) === null) return;
      try {
        await deps.join(scope, { display: sessionAnswer(principal, subject).display });
      } catch (err) {
        console.error(
          JSON.stringify({ host: 'door-join-failed', ...node, principal, message: err instanceof Error ? err.message : String(err) }),
        );
        return;
      }
    }
    await deps.hostFor(env).grantSelfShapesLocal(node.scopeId, principal);
    if (arrived.size >= 10_000) arrived.clear();
    arrived.add(key);
  };

  /** The caller's stub, carrying the address the issuer verified (K-61). */
  const scopeFor = (env: E, node: DoorNode, principal: PrincipalId, subject: AuthSubject, options?: ScopeStubOptions) =>
    deps.hostFor(env).getScope(principal, node.tenantId, node.scopeId, { ...options, verifiedEmail: verifiedEmailOf(subject) });

  const callerOf = async (env: E, req: Request) => {
    const node = deps.nodeFor(req, env);
    const instance = await wiring(env, node);
    const subject = await providerOf(instance).resolve(req.headers);
    const directory = deps.directory(env, node);
    let principal = subject ? await directory.resolvePrincipal(node.scopeId, subject.sub) : null;
    if (subject && !principal) principal = await admit(env, node, directory, subject);
    return { node, subject, principal, identity: instance.identity };
  };

  /**
   * Someone signed in and bound to nobody here, admitted by an open member invite naming the
   * address their issuer verified (K-61 phase 3). Null for everybody else, who is answered as
   * before. A second first request racing this one can lose the invite's single use to it, so a
   * refusal asks the directory once more: the winner's binding is theirs too.
   */
  const admit = async (env: E, node: DoorNode, directory: IdentityStub, subject: AuthSubject): Promise<string | null> => {
    const email = verifiedEmailOf(subject);
    if (email === null) return null;
    const host = deps.hostFor(env);
    const admitted = await admitByAddress(
      { directory, exchangeById: (id) => host.exchangeBecomeLinkById(node.tenantId, node.scopeId, id) },
      node.scopeId,
      subject.sub,
      email,
    );
    if (admitted) {
      console.log(JSON.stringify({ host: 'door-admitted', ...node, principal: admitted }));
      return admitted;
    }
    return directory.resolvePrincipal(node.scopeId, subject.sub);
  };

  /** The caller, bound here, with their stub — 401 for nobody. */
  const signedIn = async (c: Context<{ Bindings: E }>, options?: ScopeStubOptions) => {
    const { node, subject, principal } = await callerOf(c.env, c.req.raw);
    if (!principal || !subject) throw new HTTPException(401, { message: 'unauthorized' });
    const who = principalId.parse(principal);
    return { node, subject, principal: who, scope: await scopeFor(c.env, node, who, subject, options) };
  };

  const mountInvites = (app: Hono<{ Bindings: E }>, invites: DoorInvites) => {
    app.post('/api/member-invites', async (c) => {
      const { node, principal: caller, scope } = await signedIn(c);
      const { email, roleKey } = await bodyOf(c, memberInviteBody);
      if (!invites.roles.includes(roleKey)) throw new HTTPException(400, { message: `unknown role '${roleKey}'` });
      const host = deps.hostFor(c.env);
      const directory = deps.directory(c.env, node);
      const expiresAt = instant.parse(new Date(Date.now() + MEMBER_INVITE_TTL_MS).toISOString());
      const minted = await mintMemberInvite(
        {
          grant: (assignee) => host.assignScopeRoleBounded(node.tenantId, node.scopeId, caller, assignee, roleKey),
          mint: (link) => host.mintBecomeCapabilityBounded(node.tenantId, node.scopeId, caller, link),
          // The vertical decides BEFORE the row exists: until the row is written nothing can admit
          // anyone by it, so a refusal here leaves nobody bound. A throw from either step takes the
          // link and the grant back (`mintMemberInvite`); a row that cannot be written after the
          // vertical said yes asks the vertical to take its own record back too.
          record: async (principal, tokenHash, link) => {
            const invitation = { principal, email, roleKey };
            await invites.send(scope, { ...invitation, expiresAt });
            try {
              await directory.createInvite(node.scopeId, principal, roleKey, email, tokenHash, link);
            } catch (err) {
              await invites.cancel(scope, invitation).catch((cause) => {
                console.error(JSON.stringify({ host: 'door-invite-cancel-failed', ...node, principal, message: String(cause) }));
              });
              throw err;
            }
          },
          revokeCapability: (link) => host.revokeBecomeCapability(node.tenantId, node.scopeId, link, caller),
          rollback: (principal) => host.revokeScopeRole(node.scopeId, principal, roleKey),
        },
        { roleKey, email, origin: new URL(c.req.url).origin, expiresAt },
      );
      if (!minted.ok) throw uncovered(minted.coverage.missing, roleKey, 'invite at');
      // The link's secret goes no further than this: the person is admitted by their address.
      return c.json({ principal: principalId.parse(minted.invite.principal), email, roleKey, expiresAt }, 201);
    });

    app.post('/api/member-invites/:principal/withdraw', async (c) => {
      const { node, principal: caller, scope } = await signedIn(c);
      const invited = principalId.safeParse(c.req.param('principal'));
      const directory = deps.directory(c.env, node);
      const invite = invited.success ? await directory.getInvite(node.scopeId, invited.data) : null;
      // No open invite: nothing to withdraw, answered as `mountInviteRoutes` answers it.
      if (!invited.success || !invite) return c.body(null, 204);
      // The platform's half goes FIRST, so no failure after it can leave an invite that still admits:
      // its roles, bounded by every role the invited principal holds now (a role the tenant no longer
      // defines is taken without one), then its link, then its row (`withdrawMemberInvite`'s order).
      const host = deps.hostFor(c.env);
      const taken = await host.revokeScopeRolesBounded(node.tenantId, node.scopeId, caller, invited.data);
      if (!taken.coverage.covered) throw uncovered(taken.coverage.missing, invited.data, 'withdraw the invite of');
      await withdrawMemberInvite(
        { directory, revokeCapability: (link) => host.revokeBecomeCapability(node.tenantId, node.scopeId, link, caller) },
        node.scopeId,
        invited.data,
      );
      // Someone admitted by the invite between the read and the revoke holds nothing now; the
      // principal was minted for this invite alone, so they go too, as a member removal unbinds.
      await directory.unbindPrincipal(node.scopeId, invited.data);
      // Then the vertical's own record. Its refusal is the answer, though the invite is gone by now.
      await invites.cancel(scope, { principal: invited.data, email: invite.email, roleKey: invite.roleKey });
      return c.body(null, 204);
    });
  };

  return {
    mount(app) {
      app.on(['GET', 'POST'], '/api/auth/*', async (c) => (await authProvider(c.env, c.req.raw)).handle(c.req.raw));
      mountSession(app, {
        caller: (c) => callerOf(c.env, c.req.raw),
        directory: deps.directory,
        // Every screen asks this first, so it is where a person signed in from a browser arrives.
        extra: async (c, { node, principal, subject }) => {
          const who = principalId.parse(principal);
          await arrive(c.env, node, who, subject, await scopeFor(c.env, node, who, subject));
          return {};
        },
      });
      mountOwnerClaim(app, { nodeFor: deps.nodeFor, authProvider, directory: deps.directory, host: deps.hostFor });
      if (deps.invites) mountInvites(app, deps.invites);
    },

    async scope(c, options) {
      const { node, subject, principal, scope } = await signedIn(c, options);
      // Before the operation, so a client that never asks `/api/me` (MCP, a script) has arrived too.
      await arrive(c.env, node, principal, subject, scope);
      return scope;
    },

    settings: async (env, node) => (await wiring(env, node)).settings,

    platform: {
      onProvision: async (env, b) => {
        const directory = deps.directory(env, b);
        await directory.setPendingOwner(b.scopeId, b.owner, b.parentScopeId);
        // The places repair (#1670): a no-op before an issuer is delivered, and it never throws.
        const { identity } = await wiring(env, b);
        await reportScopeMembers(directory, placesReporter({ identity }), b.scopeId);
      },
      onConfigure: (env, b) => deps.directory(env, b).setScopeConfig(b.scopeId, b.entries),
      onReadPreviewConfig: (env, b) => deps.directory(env, b).getScopeConfig(b.scopeId),
      onDeleteScope: async (env, scopeId, tenantId) => {
        if (tenantId) await deps.directory(env, { tenantId, scopeId }).deleteScopeConfig(scopeId);
      },
      resolveOwner: async (env, ref) => {
        const owner = await deps.directory(env, ref).getOwnerOfRecord(ref.scopeId);
        return owner ? principalId.parse(owner) : null;
      },
      ownerSeat: (env, ref) => deps.directory(env, ref).ownerSeat(ref.scopeId),
      mintOwnerClaim: (env, ref, input) =>
        mintOwnerClaimLink({ directory: deps.directory(env, ref), host: deps.hostFor(env) }, ref, input.origin, input.actor),
      transferOwner: (env, ref, input) =>
        deps.directory(env, ref).transferOwner(ref.scopeId, input.from, input.to, input.toHoldsRole),
      completeOwnerTransfer: (env, ref, input) =>
        deps.directory(env, ref).completeOwnerTransfer(ref.scopeId, input.from, input.to),
      abandonOwnerTransfer: (env, ref, input) =>
        deps.directory(env, ref).abandonOwnerTransfer(ref.scopeId, input.from, input.to, input.toHoldsRole),
    },
  };
}
