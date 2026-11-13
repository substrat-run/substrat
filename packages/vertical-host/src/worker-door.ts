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
 * refused; a refusal takes the rest back. An address has one open invite at a time (a second is
 * 409). A withdrawal decides who may withdraw before anything is withdrawn: the platform's bound
 * over the invite's role, then the vertical's operation, which updates its own record; then the
 * platform's half goes, bounded by the roles the invited principal holds. Listing is the vertical's
 * own read.
 *
 * A worker that hands out invite LINKS instead mounts `mountInviteRoutes` beside this, with its own
 * admin gate; an invite naming an address is accepted there only by a verified holder of it.
 *
 * Files are reached the same way operations are (#3139). `attachments(c)` is the caller's file
 * surface, minted from the session as the stub is, so a route never names whose files it reads; and
 * when the worker names `attachments`, the door serves and removes a file itself at
 * `/api/attachments/:attachmentId`, streamed and seekable, as the signed-in person.
 */
import type { Context, Hono } from 'hono';
import { HTTPException } from 'hono/http-exception';
import {
  principalId,
  substratError,
  type CapabilityExchange,
  type CapabilityId,
  type EntityRef,
  type EnvVarSpec,
  type PermissionKey,
  type PrincipalId,
  type ScopeId,
  type TenantId,
} from '@substrat-run/contracts';
import { personaPrincipal, seatWorldWith, type ScopeAttachments, type ScopeHost, type ScopeStub, type ScopeStubOptions, type SeedWorld } from '@substrat-run/kernel';
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
  MEMBER_INVITE_LABEL,
  admitByAddress,
  mountMemberInvites,
  type MemberInvitation,
  type MemberInviteHost,
  type MemberInvites,
} from '@substrat-run/vertical-auth/invite-routes';
import { mountOwnerClaim, type OwnerClaimRouteDeps } from '@substrat-run/vertical-auth/owner-claim-routes';
import { mountSession, sessionAnswer } from '@substrat-run/vertical-auth/session-route';
import { hardenFileResponse, serveAttachment } from './attachment-serve.js';
import { mountDownloadLinkRedeem } from './download-link.js';
import { problemResponse } from './errors.js';
import type { PlatformSurfaceDeps, SeedWorldHook } from './index.js';

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
  hostFor: (env: E) => Pick<ScopeHost, 'getScope'> & OwnerClaimMintHost & ReturnType<OwnerClaimRouteDeps<E, DoorNode>['host']> & SelfShapeHost & DoorInviteHost & PersonaSeatHost & Partial<Pick<ScopeHost, 'attachments'>> & Pick<ScopeHost, 'openDownloadLink'>;
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
   * The vertical's sample world (`src/world.ts`, #3108). Named, it is what a seeded preview of
   * this deployment holds: the platform seats its personas there, builds its records once, and
   * lets a member of the team sign in as any of them. Seated nowhere else: the route that seats
   * it refuses every scope but a clean-room preview.
   */
  world?: SeedWorld;
  /**
   * Member invites through the door (K-61 phase 3): the two routes above, and the vertical's own
   * operations they run as the caller. Omit it and neither route is mounted; a person a member
   * invite names (made by the dashboard, say) is still admitted by their verified address.
   */
  invites?: DoorInvites;
  /**
   * The door's own file routes (#3139), over `attachments(c)`:
   *
   *   GET    /api/attachments/:attachmentId   → 200 the file, streamed; 206 for a byte range
   *   DELETE /api/attachments/:attachmentId   → 204
   *   GET    /api/attachment-downloads/:attachmentId/:secret   → a download link's file (`mountDownloadLinkRedeem`)
   *
   * Each as the signed-in person, so a read is gated by the target's `readPermission` and a removal
   * by its `writePermission`, on the entity the file hangs on. Served as `serveAttachment` serves a
   * file: hardened, always a download, and playable from an `<audio>` or `<video>` element, which
   * seeks with byte ranges. Omit it and none of the three is mounted; `attachments(c)` is there either way.
   */
  attachments?: true;
}

/** Where the door serves and removes a file when `attachments` is named (#3139). */
export const DOOR_ATTACHMENT_PATH = '/api/attachments/:attachmentId';

/** What a worker names to let its people invite by address through the door (K-61 phase 3). */
export type DoorInvites = MemberInvites;

/** An open member invite, as the vertical's operations are told about it. */
export type DoorInvitation = MemberInvitation;

/** The host call that gives a person the shapes declared for their own record. */
export interface SelfShapeHost {
  grantSelfShapesLocal(scopeId: ScopeId, principal: PrincipalId): Promise<EntityRef[]>;
}

/**
 * The scope-local verbs a seeded preview's personas are seated with (#3108). `CloudflareScopeHost`
 * has both; they are optional so a worker that names no `world` need not.
 */
export interface PersonaSeatHost {
  assignScopeRole?(scopeId: ScopeId, principal: PrincipalId, roleKey: string, door?: 'person' | 'platform'): Promise<void>;
  grantEntityShapeLocal?(scopeId: ScopeId, principal: PrincipalId, entity: EntityRef, permissions: readonly PermissionKey[]): Promise<void>;
  hasScopeRoleLocal?(tenantId: TenantId, scopeId: ScopeId, principal: PrincipalId): Promise<boolean>;
}

/**
 * The host verbs admission and the invite routes run (K-61 phase 3) — the scope's own, bounded
 * where a person is the one asking. `CloudflareScopeHost` has every one.
 */
export interface DoorInviteHost extends MemberInviteHost {
  /** A member invite's link exchanged by id, for one carrying `label` (`MEMBER_INVITE_LABEL`) only. */
  exchangeBecomeLinkById(tenantId: TenantId, scopeId: ScopeId, capabilityId: CapabilityId, label: string): Promise<CapabilityExchange | null>;
}

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
  /**
   * `/api/auth/*` (the login round-trip), `/api/me`, `/api/claim-owner`, `/api/member-invites*` when
   * `invites` is named, and `/api/attachments/:attachmentId` when `attachments` is.
   */
  mount(app: Hono<{ Bindings: E }>): void;
  /** The caller's scope stub, with their verified address. 401 for nobody. */
  scope(c: Context<{ Bindings: E }>, options?: ScopeStubOptions): Promise<ScopeStub>;
  /**
   * The caller's files on this scope (#3139): read, upload and remove as them, each gated by the
   * file's target as `ctx.check` would gate it. The id comes from the session, as the stub's does,
   * so a route never names whose files it reads. 401 for nobody. Serve one with `serveAttachment`.
   */
  attachments(c: Context<{ Bindings: E }>): Promise<ScopeAttachments>;
  /**
   * The declared settings for one scope: delivered value, then binding, then default. Read them
   * here and never off `env`: a default rides as a binding every install of a script shares.
   */
  settings(env: E, node: DoorNode): Promise<InstanceAuth['settings']>;
  /** Spread into `mountPlatformSurface`, so what the platform delivers lands in the directory. */
  platform: DoorHooks<E> & { seedWorld?: SeedWorldHook<E> };
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
    const { principal, contested } = await admitByAddress(
      { directory, exchangeById: (id) => host.exchangeBecomeLinkById(node.tenantId, node.scopeId, id, MEMBER_INVITE_LABEL) },
      node.scopeId,
      subject.sub,
      email,
    );
    if (principal) {
      console.log(JSON.stringify({ host: 'door-admitted', ...node, principal }));
      return principal;
    }
    // Only a refused exchange or bind can mean a racing request bound them meanwhile.
    return contested ? directory.resolvePrincipal(node.scopeId, subject.sub) : null;
  };

  /** The caller, bound here, with their stub — 401 for nobody. */
  const signedIn = async (c: Context<{ Bindings: E }>, options?: ScopeStubOptions) => {
    const { node, subject, principal } = await callerOf(c.env, c.req.raw);
    if (!principal || !subject) throw new HTTPException(401, { message: 'unauthorized' });
    const who = principalId.parse(principal);
    return { node, subject, principal: who, scope: await scopeFor(c.env, node, who, subject, options) };
  };
  /** The caller's files, once they have arrived as `scope` has them arrive (#3139). */
  const attachmentsOf = async (c: Context<{ Bindings: E }>): Promise<ScopeAttachments> => {
    const { node, subject, principal, scope } = await signedIn(c);
    await arrive(c.env, node, principal, subject, scope);
    const host = deps.hostFor(c.env);
    if (!host.attachments) throw substratError('unavailable', 'this scope host serves no files (ScopeHost.attachments)');
    return host.attachments(principal, node.tenantId, node.scopeId);
  };



  /**
   * Seat the world in a seeded preview (#3108). A persona is linked in this tenant's identity
   * directory, which a sign-in reads, and seated as a principal derived from the scope and its
   * `sub`: every push binds a new script whose directory starts empty while the scope's data is
   * carried, so the same persona must come back as the same principal. The role goes through the
   * person's door, so a role holding a key reserved to a system principal is refused (#2430).
   */
  const seedWorld = (world: SeedWorld): SeedWorldHook<E> => ({
    personas: world.personas
      .filter((p) => !p.elsewhere)
      .map((p) => ({ sub: p.sub, name: p.name, email: p.email, ...(p.role ? { role: p.role } : {}), ...(p.note ? { note: p.note } : {}) })),
    seat: async (env, b) => {
      const directory = deps.directory(env, b);
      const host = deps.hostFor(env);
      const { assignScopeRole, grantEntityShapeLocal } = host;
      if (!assignScopeRole || !grantEntityShapeLocal) {
        throw new HTTPException(501, { message: 'this deployment cannot seat a sample world — redeploy it' });
      }
      // Built once per scope's data. The platform says when the scope is new; a scope it reuses
      // is built too while none of the world's role holders holds a role in it yet, as a preview
      // created before it was first seeded has none. Read before seating, which gives them one.
      let build = b.build;
      const holders = world.personas.filter((p) => p.role && !p.elsewhere && !p.invited);
      if (!build && holders.length > 0 && host.hasScopeRoleLocal) {
        const held = await Promise.all(
          holders.map(async (p) => host.hasScopeRoleLocal!(b.tenantId, b.scopeId, await personaPrincipal(b.scopeId, p.sub))),
        );
        build = !held.some(Boolean);
      }
      await seatWorldWith(
        {
          resolve: async (sub) => {
            const bound = await directory.boundPrincipal(b.scopeId, sub);
            return bound ? principalId.parse(bound) : null;
          },
          principalFor: (sub) => personaPrincipal(b.scopeId, sub),
          seat: async (persona, principal) => {
            if (persona.role) await assignScopeRole.call(host, b.scopeId, principal, persona.role, 'person');
            await directory.bindPersona(b.scopeId, persona.sub, principal);
          },
          grantShape: ({ principal, entity, permissions }) => grantEntityShapeLocal.call(host, b.scopeId, principal, entity, permissions),
          invoke: async (persona, principal, operation, input) =>
            (await host.getScope(principal, b.tenantId, b.scopeId, { verifiedEmail: persona.email })).invoke(operation, input),
        },
        { world, build },
      );
    },
  });

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
      if (deps.invites) {
        mountMemberInvites(app, { signedIn, directory: deps.directory, host: deps.hostFor, invites: deps.invites });
      }
      if (deps.attachments) {
        app.get(DOOR_ATTACHMENT_PATH, async (c) => {
          hardenFileResponse(c);
          try {
            return await serveAttachment(c, await attachmentsOf(c), c.req.param('attachmentId'));
          } catch (err) {
            return problemResponse(c, err);
          }
        });
        // A download link needs no session: the file is read as the person who minted it.
        mountDownloadLinkRedeem(app, { host: (c) => deps.hostFor(c.env), node: (c) => deps.nodeFor(c.req.raw, c.env) });
        app.delete(DOOR_ATTACHMENT_PATH, async (c) => {
          try {
            const removed = await (await attachmentsOf(c)).remove(c.req.param('attachmentId'));
            if (!removed) throw substratError('not_found', 'no such file');
            return c.body(null, 204);
          } catch (err) {
            return problemResponse(c, err);
          }
        });
      }
    },

    async scope(c, options) {
      const { node, subject, principal, scope } = await signedIn(c, options);
      // Before the operation, so a client that never asks `/api/me` (MCP, a script) has arrived too.
      await arrive(c.env, node, principal, subject, scope);
      return scope;
    },

    attachments: attachmentsOf,

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
      ...(deps.world ? { seedWorld: seedWorld(deps.world) } : {}),
    },
  };
}
