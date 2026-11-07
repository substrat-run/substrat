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
 * On its own subpath because `IdentityDO` is a Durable Object: `cloudflare:workers` does not load
 * in the node server a vertical's dev loop runs, which imports this package's root.
 *
 * Not here: member invites. Who may invite is the vertical's own question, so a worker that wants
 * them mounts `mountInviteRoutes` beside this, with its own admin gate.
 */
import type { Context, Hono } from 'hono';
import { HTTPException } from 'hono/http-exception';
import { principalId, type EnvVarSpec, type ScopeId, type TenantId } from '@substrat-run/contracts';
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
  type IdentityStub,
  type InstanceAuth,
  type OwnerClaimMintHost,
} from '@substrat-run/vertical-auth';
import { mountOwnerClaim, type OwnerClaimRouteDeps } from '@substrat-run/vertical-auth/owner-claim-routes';
import { mountSession } from '@substrat-run/vertical-auth/session-route';
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
  hostFor: (env: E) => Pick<ScopeHost, 'getScope'> & OwnerClaimMintHost & ReturnType<OwnerClaimRouteDeps<E, DoorNode>['host']>;
  /** The vertical's declared settings, resolved per scope with the delivered values. */
  envSpec: EnvVarSpec[];
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
  /** `/api/auth/*` (the login round-trip), `/api/me` and `/api/claim-owner`. */
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

  const callerOf = async (env: E, req: Request) => {
    const node = deps.nodeFor(req, env);
    const instance = await wiring(env, node);
    const subject = await providerOf(instance).resolve(req.headers);
    const principal = subject ? await deps.directory(env, node).resolvePrincipal(node.scopeId, subject.sub) : null;
    return { node, subject, principal, identity: instance.identity };
  };

  return {
    mount(app) {
      app.on(['GET', 'POST'], '/api/auth/*', async (c) => (await authProvider(c.env, c.req.raw)).handle(c.req.raw));
      mountSession(app, { caller: (c) => callerOf(c.env, c.req.raw), directory: deps.directory });
      mountOwnerClaim(app, { nodeFor: deps.nodeFor, authProvider, directory: deps.directory, host: deps.hostFor });
    },

    async scope(c, options) {
      const { node, subject, principal } = await callerOf(c.env, c.req.raw);
      if (!principal) throw new HTTPException(401, { message: 'unauthorized' });
      return deps.hostFor(c.env).getScope(principalId.parse(principal), node.tenantId, node.scopeId, {
        ...options,
        verifiedEmail: verifiedEmailOf(subject),
      });
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
