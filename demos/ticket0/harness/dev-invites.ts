/**
 * The dev server's half of the invite flow: a file-backed pending-invite store, the
 * role and grant an invite writes, and the identity link an acceptance makes.
 *
 * The hosted worker keeps all of that in the tenant's identity DO and the scope's own
 * storage. Node has no DO, so this is the same set of facts written beside the seeded
 * cast — deliberately the ONLY thing the dev server does differently, with the flow
 * itself shared in `invites.ts`. Manyfold answered the same problem with a second copy
 * of the routes over its own sqlite table, and a second copy is how a dev login stops
 * resembling the login a customer runs.
 *
 * ── One node, two desks ──────────────────────────────────────────────────────
 * The dev server seeds two desks behind one origin. An invite is stored under its
 * scope, and a CLAIM searches every scope for the one whose hash matches — because the
 * person accepting has no principal yet and therefore no desk for the request to
 * carry. That is the same question `widget-surface.ts` answers from the embedding
 * origin, asked of a caller who has nothing else to answer it with. A hosted install
 * has one desk per hostname and the router asserts it, which is why `worker.ts` never
 * has to ask.
 */
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { capabilityId as capabilityIdOf, type PlatformActorId, type PrincipalId, type ScopeId, type TenantId } from '@substrat-run/contracts';
import type { SqliteScopeHost } from '@substrat-run/adapter-sqlite';
import type { ClaimedInvite, InviteDesk, PendingInvite } from './invites.js';

/** A stored invite. The token itself was shown once and never written down. */
interface StoredInvite {
  scopeId: string;
  tenantId: string;
  principal: string;
  roleKey: string;
  email: string | null;
  tokenHash: string;
  /** The `become` capability the link is (#1686); absent on an invite written before it. */
  capabilityId?: string | null;
  createdAt: string;
}

export interface DevNode {
  tenantId: TenantId;
  scopeId: ScopeId;
}

export interface DevInviteDeskOptions {
  /** Where to persist — a path beside `.data/cast.json`. */
  readonly file: string;
  /** The pure-SQLite host — its bounded verbs are the invite's, as the worker's host's are. */
  readonly host: SqliteScopeHost;
  /** The local platform actor the identity link and a rollback are stamped with. */
  readonly actor: PlatformActorId;
  /** The identity pool the dev issuer's subjects live in. */
  readonly provider: string;
  /**
   * The desk the SIGNED-IN caller works in, or null when nobody is signed in — which
   * is the ordinary state of somebody following an invite link for the first time.
   */
  readonly caller: DevNode | null;
}

/**
 * One request's desk.
 *
 * Built per request on purpose: a claim discovers which desk the token named, and that
 * discovery has to be visible to the `invokeAs` that writes the new colleague's
 * profile a moment later. Holding it in a module-level variable would make two people
 * accepting invites at the same time each other's problem.
 */
export function devInviteDesk(opts: DevInviteDeskOptions): InviteDesk {
  const read = (): StoredInvite[] => {
    if (!existsSync(opts.file)) return [];
    try {
      return JSON.parse(readFileSync(opts.file, 'utf8')) as StoredInvite[];
    } catch {
      // A truncated or hand-edited file loses the pending invites and nothing else:
      // the roles they granted are already in the scope, and a new link can be minted.
      return [];
    }
  };
  /**
   * Read and write on every call rather than keeping an in-memory copy: the file is
   * tiny, and a cached copy would go stale against the `pnpm dev` restart that happens
   * on every file save — exactly when somebody is holding a link they were given a
   * minute ago.
   */
  const write = (rows: StoredInvite[]) => writeFileSync(opts.file, JSON.stringify(rows, null, 2));

  /** The caller's desk until a claim finds one; then the desk the token named. */
  let node: DevNode | null = opts.caller;
  const nodeOrThrow = (): DevNode => {
    if (!node) throw new Error('no desk for this request — sign in, or follow an invite link');
    return node;
  };

  /**
   * Bind this subject to `match`'s pre-minted principal, and consume the invite.
   *
   * The link goes into the kernel's OWN identity directory — the same table the
   * seeded personas are in, and the same one `caller()` reads — so an accepted
   * invitee then signs in through exactly the path everybody else does. Nothing
   * about their login is a shortcut except which issuer minted the subject.
   */
  const bindTo = async (sub: string, match: StoredInvite, rows: StoredInvite[]): Promise<ClaimedInvite> => {
    const desk = { tenantId: match.tenantId as TenantId, scopeId: match.scopeId as ScopeId };
    await opts.host.admin.linkIdentity(opts.actor, {
      provider: opts.provider,
      externalId: sub,
      principal: match.principal as PrincipalId,
      tenantId: desk.tenantId,
      scopeId: desk.scopeId,
    });
    write(rows.filter((i) => i !== match));
    return { principal: match.principal, roleKey: match.roleKey };
  };

  return {
    store: {
      async list(): Promise<PendingInvite[]> {
        if (!node) return [];
        const scope = node.scopeId;
        return read()
          .filter((i) => i.scopeId === scope)
          .map(({ principal, roleKey, email, createdAt }) => ({
            principal,
            roleKey,
            email,
            created_at: createdAt,
          }));
      },
      async create({ principal, roleKey, email, tokenHash, capabilityId }) {
        const desk = nodeOrThrow();
        write([
          ...read(),
          {
            scopeId: desk.scopeId,
            tenantId: desk.tenantId,
            principal,
            roleKey,
            email,
            tokenHash,
            capabilityId,
            createdAt: new Date().toISOString(),
          },
        ]);
      },
      async linkOf(principal) {
        const desk = nodeOrThrow();
        return read().find((i) => i.scopeId === desk.scopeId && i.principal === principal)?.capabilityId ?? null;
      },
      async revoke(principal) {
        const desk = nodeOrThrow();
        write(read().filter((i) => !(i.scopeId === desk.scopeId && i.principal === principal)));
      },
      /**
       * A link's hash names its desk too: the person accepting has no principal yet and
       * therefore no desk for the request to carry, so the match is what says which scope
       * the exchange that follows runs in.
       */
      async matches(tokenHash) {
        const match = read().find((i) => i.tokenHash === tokenHash && i.capabilityId);
        if (!match) return false;
        node = { tenantId: match.tenantId as TenantId, scopeId: match.scopeId as ScopeId };
        return true;
      },
      async claimByCapability(sub, capabilityId, principal) {
        const rows = read();
        const match = rows.find((i) => i.capabilityId === capabilityId && i.principal === principal);
        return match ? bindTo(sub, match, rows) : null;
      },
      // LEGACY: an invite written before #1686, matched by its hash alone.
      async claim(sub, tokenHash) {
        const rows = read();
        const match = rows.find((i) => i.tokenHash === tokenHash && !i.capabilityId);
        if (!match) return null;
        node = { tenantId: match.tenantId as TenantId, scopeId: match.scopeId as ScopeId };
        return bindTo(sub, match, rows);
      },
    },

    grantRole: (caller, principal, roleKey) => {
      const desk = nodeOrThrow();
      return opts.host.assignScopeRoleBounded(desk.tenantId, desk.scopeId, caller, principal, roleKey);
    },
    revokeRole: (principal, roleKey) =>
      opts.host.admin.unassignRole(opts.actor, { principalId: principal, roleKey, node: nodeOrThrow() }),
    mintLink: (caller, input) => {
      const desk = nodeOrThrow();
      return opts.host.mintBecomeCapabilityBounded(desk.tenantId, desk.scopeId, caller, input);
    },
    revokeLink: (caller, capabilityId) => {
      const desk = nodeOrThrow();
      return opts.host.revokeBecomeCapability(desk.tenantId, desk.scopeId, capabilityIdOf.parse(capabilityId), caller);
    },
    exchange: (secret) => {
      const desk = nodeOrThrow();
      return opts.host.exchangeCapability(desk.tenantId, desk.scopeId, secret, { mode: 'become' });
    },

    invokeAs: async (principal, operation, input) => {
      const desk = nodeOrThrow();
      const scope = await opts.host.getScope(principal as PrincipalId, desk.tenantId, desk.scopeId);
      return scope.invoke(operation, input);
    },
  };
}
