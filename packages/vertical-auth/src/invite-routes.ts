/**
 * The MEMBER INVITE routes a vertical mounts — the post-setup join path (#1150).
 *
 * Three demo workers carried these four routes verbatim: list the open invites, create
 * one, revoke one, and accept one. The copies agreed byte-for-byte on the parts that
 * matter — the token shape, that only its HASH is stored, that the role is granted BEFORE
 * the invite is recorded, the status codes and the messages — and nothing but a diff held
 * them in step. So the routes live here once, and a vertical supplies only what is its own:
 * how a request resolves to a scope, who counts as an admin, which roles a teammate may be
 * invited at, and the host that grants the role.
 *
 * What an invite IS does not change by moving here. Creating one pre-mints a member
 * principal, grants it the chosen role at scope level (a real grant — the principal can
 * act the moment somebody binds to it), and records the invite in the tenant's identity
 * directory keyed by the token's SHA-256; the plaintext token rides only in the returned
 * accept link. Accepting binds the invitee's verified subject to that pre-minted principal,
 * and the directory then resolves them as that member. Revoking takes the principal's scope
 * roles back and then removes the invite row.
 *
 * Since #1686 the token is the secret of a `become` capability in the scope's own Durable
 * Object, minted by the inviter under a bound (they must hold everything the invited
 * principal holds): single use, revocable, and on the spine — its mint as
 * `capability.become-minted` with the inviter as actor, its accept as `capability.exercised`.
 * It has no expiry, as an invite never had, and the inviter is not re-checked at accept:
 * the role was bounded when it was granted, and withdrawing the invite is the lever. An
 * invite minted before #1686 is redeemed the old way, by hash (`claimInvite`).
 *
 * Who may invite, and at which role, are two questions (#1931). The vertical's admin gate
 * answers the first — may this caller manage members at all. The second is the kernel's
 * assignment bound (`ctx.canAssign`): a caller may confer a role only if they already hold
 * every permission it carries at this scope, and withdrawing an invite takes the same bound,
 * over the roles its principal holds now — the scope's tuples, never the row's `roleKey`. The
 * gate runs before the body is read, so it cannot know the role; the bound is applied here,
 * after the role is parsed, by the platform rather than by each vertical remembering it —
 * otherwise a vertical offering two roles lets anyone its gate admits confer the higher one.
 *
 * The dashboard manages the same members through vertical-host's `/internal/members*` (#1150),
 * minting with the same `mintMemberInvite` below. Deliberately NOT here: the richer invite a
 * support desk runs (contact-bound roles, staff profiles), which is a different flow rather
 * than this one with more fields.
 */

import type { Context, Hono } from 'hono';
import { HTTPException } from 'hono/http-exception';
import {
  boundedBecomeMint,
  capabilityId,
  coverage,
  coverageRefusal,
  principalId,
  z,
  type BoundedBecomeMint,
  type CapabilityExchange,
  type CapabilityId,
  type Coverage,
  type MemberInviteLink,
  type PrincipalBecomeCapabilityInput,
  type PrincipalId,
  type ScopeId,
  type TenantId,
} from '@substrat-run/contracts';
import { capabilityTokenHash, plausibleCapabilitySecret, ulid } from '@substrat-run/kernel';
import type { IdentityStub } from './identity-do.js';
import { invitePath, sha256Hex } from './owner-claim-link.js';
import { bodyOf } from './request-body.js';
import type { AuthProvider } from './provider.js';

/** The slice of the identity directory the invite routes touch. */
export type InviteDirectory = Pick<
  IdentityStub,
  'listInvites' | 'getInvite' | 'createInvite' | 'revokeInvite' | 'claimInvite' | 'inviteMatches' | 'claimInviteByCapability'
>;

/** The label every member invite's capability carries — what an operator's capability read shows. */
export const MEMBER_INVITE_LABEL = 'member invite';

const inviteCaller = z.object({ principal: principalId });

/** Who the admin gate admitted — the principal the assignment bound is asked about. */
export type InviteCaller = z.infer<typeof inviteCaller>;

/** The body `POST /api/invites` takes. */
export const inviteBody = z.object({
  email: z.string().email().optional(),
  /** One of the vertical's roles — validated against `roles` below. */
  roleKey: z.string().min(1),
});

/** The body `POST /api/accept-invite` takes. */
export const acceptInviteBody = z.object({ token: z.string().min(1) });

/**
 * What the vertical supplies. `E` is its worker's bindings; `N` is whatever it resolves a
 * request to — the routes only read `scopeId` off it, and hand the whole node back to
 * `directory`, so a vertical whose node carries more (a tenant, a site) loses nothing.
 */
export interface InviteRouteDeps<E extends object, N extends { scopeId: string }> {
  /** The (tenant, scope) this request addresses — behind the router, from the assertion. */
  nodeFor: (req: Request, env: E) => N | Promise<N>;
  /**
   * Gate the three admin routes: throw 401 for nobody, 403 for a caller who may not manage
   * members. The vertical decides what "admin" means — a role, a permission, a whoami — and
   * returns the principal it admitted, which is who every bound is then asked about.
   */
  requireAdmin: (c: Context<{ Bindings: E }>) => Promise<InviteCaller>;
  /**
   * Take every scope role `principal` holds, bounded by `caller` over each, in ONE scope task —
   * the host's `revokeScopeRolesBounded`. What a withdrawal is bounded by (#1150): the roles the
   * invite's principal ACTUALLY holds, read where they are written, never the role the invite row
   * recorded when it was minted. Required: a mount without it refuses create and revoke.
   */
  revokeScopeRolesBounded: (
    env: E, node: N, caller: PrincipalId, principal: PrincipalId,
  ) => Promise<{ coverage: Coverage; revoked: string[] }>;
  /** Check the bound and grant in one scope task. A refusal returns coverage and writes nothing. */
  assignScopeRoleBounded: (
    env: E, node: N, caller: PrincipalId, assignee: PrincipalId, roleKey: string,
  ) => Promise<Coverage>;
  /** The role keys a teammate may be invited at — the vertical's own ROLES. */
  roles: readonly string[];
  /** The tenant's identity directory — the invite rows and the sub → principal binding. */
  directory: (env: E, node: N) => InviteDirectory;
  /**
   * Take that grant back — the host's `revokeScopeRole`. The grant and the invite row live
   * in two different Durable Objects, so the create has no transaction across them: when
   * the row cannot be written after the role was granted, this is what puts the scope back
   * where it was, rather than leaving a principal nobody can ever bind to holding a role.
   */
  revokeScopeRole: (env: E, scopeId: N['scopeId'], principal: PrincipalId, roleKey: string) => Promise<unknown>;
  /**
   * Mint the invite's link (#1686) — the host's `mintBecomeCapabilityBounded`: a `become`
   * capability for the pre-minted principal, minted by `caller` and bounded by what `caller`
   * holds, check and write in one scope task. Required: a mount without it refuses create.
   */
  mintBecomeCapabilityBounded: (
    env: E, node: N, caller: PrincipalId, input: PrincipalBecomeCapabilityInput,
  ) => Promise<BoundedBecomeMint>;
  /**
   * Revoke an invite's link (#1686) — the host's `revokeBecomeCapability`, recording `by`. What a
   * withdrawal does to the capability once the row is gone, and what a failed create undoes.
   */
  revokeBecomeCapability: (env: E, node: N, capabilityId: CapabilityId, by: PrincipalId) => Promise<boolean>;
  /** Exchange an invite's secret in the scope (#1686) — the host's `exchangeCapability`, `become` only. */
  exchangeCapability: (env: E, node: N, secret: string) => Promise<CapabilityExchange | null>;
  /** The configured `AuthProvider` — who is accepting. Resolved per request, as the vertical does. */
  authProvider: (env: E, req: Request) => Promise<AuthProvider>;
  /**
   * The origin the accept link is built on. Defaults to the request's own. A trailing
   * slash is tolerated — `mintOwnerClaimLink` strips one the same way — so a vertical that
   * hands over a configured `https://host/` does not send invitees to `https://host//`.
   */
  origin?: (req: Request) => string;
}

/** The 403 a refused bound answers, in one wording for every door that confers a role. */
export const uncovered = (missing: readonly string[], roleKey: string, act: string): HTTPException =>
  new HTTPException(403, { message: coverageRefusal(missing, roleKey, act) });


/**
 * Mint one member invite (#1150) — the ONE copy of what an invite is, shared by the vertical's
 * own `POST /api/invites` and the platform's `/internal/members/invite` (vertical-host), so the
 * two doors cannot drift on the token, the hash, or the order.
 *
 * Pre-mint a principal, then three writes, each failing closed:
 *   1. grant it the role through `grant`, which MUST be the bounded grant (check and write in one
 *      scope task) — a refusal returns its coverage and nothing else is written;
 *   2. mint its link (#1686): a `become` capability for that principal, single use and with no
 *      expiry (an invite has never had one), bounded by what the inviter holds — the scope's own
 *      record, on the spine as `capability.become-minted`. A refusal takes the grant back;
 *   3. record the invite under the secret's hash, naming the capability.
 * The grant comes first: a row whose principal holds nothing is a link to no access, while a
 * grant with no row is inert — nobody can bind to it, and a capability with no row is refused
 * before its exchange. The writes are two Durable Objects with no transaction between them, so a
 * failed record revokes the capability and takes the grant back (`rollback`) before the failure
 * is rethrown: inert is not harmless when every retry would mint another orphan. If a rollback
 * step fails too, the ORIGINAL failure is what the caller hears.
 */
export async function mintMemberInvite(
  steps: {
    grant: (assignee: PrincipalId) => Promise<Coverage>;
    mint: (input: PrincipalBecomeCapabilityInput) => Promise<BoundedBecomeMint>;
    record: (principal: PrincipalId, tokenHash: string, capabilityId: CapabilityId) => Promise<void>;
    revokeCapability: (capabilityId: CapabilityId) => Promise<unknown>;
    rollback: (principal: PrincipalId) => Promise<unknown>;
  },
  input: { roleKey: string; email: string | null; origin: string },
): Promise<{ ok: true; invite: MemberInviteLink } | { ok: false; coverage: Coverage }> {
  const principal = principalId.parse(ulid());
  const bound = coverage.safeParse(await steps.grant(principal));
  if (!bound.success) {
    throw new HTTPException(500, { message: 'the canAssign bound did not answer with a coverage — refusing' });
  }
  if (!bound.data.covered) return { ok: false, coverage: bound.data };
  let minted: BoundedBecomeMint;
  try {
    minted = boundedBecomeMint.parse(await steps.mint({ principal, maxUses: 1, label: MEMBER_INVITE_LABEL }));
  } catch (err) {
    await steps.rollback(principal).catch(() => undefined);
    throw err;
  }
  if (!minted.ok) {
    await steps.rollback(principal).catch(() => undefined);
    return { ok: false, coverage: minted.coverage };
  }
  const link = minted.minted;
  try {
    await steps.record(principal, await capabilityTokenHash(link.secret), link.id);
  } catch (err) {
    await steps.revokeCapability(link.id).catch(() => undefined);
    await steps.rollback(principal).catch(() => undefined);
    throw err;
  }
  const origin = input.origin.replace(/\/$/, '');
  return { ok: true, invite: { principal, roleKey: input.roleKey, email: input.email, acceptUrl: `${origin}${invitePath(link.secret)}` } };
}

/**
 * Accept an invite (#1150, #1686) — the one copy both the vertical's `/api/accept-invite` and any
 * other accept door run. A capability-era secret is checked against the directory BEFORE the
 * scope exchanges it (a withdrawn, accepted or unrelated secret keeps its use), then exchanged in
 * the scope (single use, on the spine as `capability.exercised`), then bound — only while the row
 * still names that capability and principal. A token that is not a capability secret is a LEGACY
 * invite, redeemed by hash (`claimInvite`). Null for every refusal, one answer.
 */
export async function acceptMemberInvite(
  deps: {
    directory: Pick<InviteDirectory, 'claimInvite' | 'inviteMatches' | 'claimInviteByCapability'>;
    exchange: (secret: string) => Promise<CapabilityExchange | null>;
  },
  scopeId: string,
  sub: string,
  token: string,
): Promise<string | null> {
  if (!plausibleCapabilitySecret(token)) {
    // LEGACY — an invite minted before #1686 (see `claimInvite`).
    return deps.directory.claimInvite(scopeId, sub, await sha256Hex(token));
  }
  if (!(await deps.directory.inviteMatches(scopeId, await capabilityTokenHash(token)))) return null;
  const exchanged = await deps.exchange(token);
  if (exchanged?.kind !== 'principal') return null;
  return deps.directory.claimInviteByCapability(scopeId, sub, exchanged.capabilityId, exchanged.principal);
}

/**
 * Withdraw an invite's row and then its link (#1686), once the caller's bound has taken the
 * roles. The row goes first — that is what stops an accept — and the capability it named is then
 * revoked in the scope, so the scope's own record agrees and an operator sees it revoked.
 */
export async function withdrawMemberInvite(
  steps: {
    directory: Pick<InviteDirectory, 'revokeInvite'>;
    revokeCapability: (capabilityId: CapabilityId) => Promise<unknown>;
  },
  scopeId: string,
  principal: string,
): Promise<void> {
  const link = await steps.directory.revokeInvite(scopeId, principal);
  if (link) await steps.revokeCapability(capabilityId.parse(link));
}

/**
 * Mount the four invite routes on a vertical's Hono app:
 *
 *   GET  /api/invites                    → { roles, invites }            (admin)
 *   POST /api/invites                    → 201 { principal, roleKey, email, acceptUrl } (admin)
 *   POST /api/invites/:principal/revoke  → 204                           (admin)
 *   POST /api/accept-invite              → { ok: true, principal }       (any signed-in subject)
 *
 * Every error these routes raise themselves is an `HTTPException` — a body that is not
 * JSON or does not fit its schema included, which `bodyOf` turns into a 400 rather than
 * letting a `SyntaxError` or `ZodError` out — so the vertical's own `onError`, or the
 * envelope `mountPlatformSurface` installs, renders them exactly as it renders its own,
 * and needs no branch for this mount. What the vertical's OWN deps throw (`requireAdmin`,
 * the directory, the host) is passed through untouched: those are its errors to shape.
 */
export function mountInviteRoutes<E extends object, N extends { scopeId: string }>(
  app: Hono<{ Bindings: E }>,
  deps: InviteRouteDeps<E, N>,
): void {
  const originOf = (req: Request): string => (deps.origin?.(req) ?? new URL(req.url).origin).replace(/\/$/, '');

  /** Who the gate admitted — refusing a mount wired short or a gate naming no caller. */
  const admitted = (caller: unknown): InviteCaller => {
    if (typeof deps.revokeScopeRolesBounded !== 'function') {
      throw new HTTPException(500, { message: 'invites are mounted without the bounded revoke — refusing to withdraw an unbounded role' });
    }
    if (typeof deps.assignScopeRoleBounded !== 'function') {
      throw new HTTPException(500, { message: 'invites are mounted without the bounded grant — refusing to confer an unbounded role' });
    }
    if (typeof deps.mintBecomeCapabilityBounded !== 'function' || typeof deps.revokeBecomeCapability !== 'function') {
      throw new HTTPException(500, { message: 'invites are mounted without the capability verbs — refusing to mint a link nothing can revoke' });
    }
    const parsed = inviteCaller.safeParse(caller);
    if (!parsed.success) {
      throw new HTTPException(500, { message: 'the admin gate named no caller — refusing to confer a role the bound cannot be asked about' });
    }
    return parsed.data;
  };

  /** Refuse unless the bound says `caller` holds every permission of `roleKey`. */
  const assertCoverage = (answer: unknown, roleKey: string, act: string): void => {
    const bound = coverage.safeParse(answer);
    if (!bound.success) {
      throw new HTTPException(500, { message: 'the canAssign bound did not answer with a coverage — refusing' });
    }
    if (!bound.data.covered) throw uncovered(bound.data.missing, roleKey, act);
  };

  app.get('/api/invites', async (c) => {
    const node = await deps.nodeFor(c.req.raw, c.env);
    await deps.requireAdmin(c);
    return c.json({ roles: [...deps.roles], invites: await deps.directory(c.env, node).listInvites(node.scopeId) });
  });

  app.post('/api/invites', async (c) => {
    const node = await deps.nodeFor(c.req.raw, c.env);
    // The gate first, before the body exists: a refused caller learns nothing from what they sent.
    const caller = admitted(await deps.requireAdmin(c));
    const { email, roleKey } = await bodyOf(c, inviteBody);
    if (!deps.roles.includes(roleKey)) throw new HTTPException(400, { message: `unknown role '${roleKey}'` });
    const minted = await mintMemberInvite(
      {
        grant: (assignee) => deps.assignScopeRoleBounded(c.env, node, caller.principal, assignee, roleKey),
        mint: (link) => deps.mintBecomeCapabilityBounded(c.env, node, caller.principal, link),
        record: (principal, tokenHash, link) =>
          deps.directory(c.env, node).createInvite(node.scopeId, principal, roleKey, email ?? null, tokenHash, link),
        revokeCapability: (link) => deps.revokeBecomeCapability(c.env, node, link, caller.principal),
        rollback: (principal) => deps.revokeScopeRole(c.env, node.scopeId, principal, roleKey),
      },
      { roleKey, email: email ?? null, origin: originOf(c.req.raw) },
    );
    if (!minted.ok) throw uncovered(minted.coverage.missing, roleKey, 'invite at');
    return c.json(minted.invite, 201);
  });

  app.post('/api/invites/:principal/revoke', async (c) => {
    const node = await deps.nodeFor(c.req.raw, c.env);
    const caller = admitted(await deps.requireAdmin(c));
    const directory = deps.directory(c.env, node);
    const principal = principalId.safeParse(c.req.param('principal'));
    // No open invite: nothing to withdraw, answered as before.
    const invite = principal.success ? await directory.getInvite(node.scopeId, principal.data) : null;
    if (principal.success && invite) {
      // Withdrawal takes the bound of every role the invite's principal HOLDS, asked and written in
      // one scope task (#1150, Codex #2057 r2). Not the row's `roleKey`: that is what was minted,
      // and the scope can have moved since — a role move landing between an invite's grant and its
      // row would otherwise leave a lead's invite withdrawable by an agent. The grant goes with
      // it, first: a refusal writes nothing, and the row can only go once the roles have. A role
      // the tenant no longer defines confers nothing and is taken without a bound, so a link at
      // one can still be withdrawn. An accept landing between the two binds a login to a
      // principal holding nothing.
      const taken = await deps.revokeScopeRolesBounded(c.env, node, caller.principal, principal.data);
      assertCoverage(taken.coverage, principal.data, 'withdraw the invite of');
      await withdrawMemberInvite(
        { directory, revokeCapability: (link) => deps.revokeBecomeCapability(c.env, node, link, caller.principal) },
        node.scopeId,
        principal.data,
      );
    }
    return c.body(null, 204);
  });

  // INVARIANT (#1150): an accept never writes to the scope. The role was granted when the invite
  // was minted; accepting only binds the subject in the identity directory, the same Durable
  // Object the platform's member removal withdraws the invite and unbinds in — so a removal and
  // an accept are serialized there, and an accept after a removal finds no invite. If a future
  // accept path grants in the scope (ticket0's portal grant is one), a removal marker the grant
  // checks becomes required, or a held accept could re-grant a removed person.
  app.post('/api/accept-invite', async (c) => {
    const node = await deps.nodeFor(c.req.raw, c.env);
    const subject = await (await deps.authProvider(c.env, c.req.raw)).resolve(c.req.raw.headers);
    if (!subject) throw new HTTPException(401, { message: 'sign in before accepting an invite' });
    const { token } = await bodyOf(c, acceptInviteBody);
    const principal = await acceptMemberInvite(
      { directory: deps.directory(c.env, node), exchange: (secret) => deps.exchangeCapability(c.env, node, secret) },
      node.scopeId,
      subject.sub,
      token,
    );
    if (!principal) throw new HTTPException(400, { message: 'this invite is invalid or already used' });
    return c.json({ ok: true, principal });
  });
}

/**
 * What a vertical hands `mountPlatformSurface` to let the platform manage its members from the
 * dashboard (#1150) — vertical-host's `members` hook. `roles` is the same list the vertical gives
 * `mountInviteRoutes`; `directory` is its tenant's IdentityDO; the minting is `mintMemberInvite`,
 * so an invite the dashboard asks for is the same thing the vertical's own screen makes, and is
 * accepted at the vertical's own `/api/accept-invite`.
 */
export function membersHook<E, D extends InviteDirectory & Pick<IdentityStub, 'listMemberBindings' | 'unbindPrincipal'>>(opts: {
  roles: readonly string[];
  directory: (env: E, ref: { tenantId: TenantId; scopeId: ScopeId }) => D;
}) {
  return { roles: opts.roles, directory: opts.directory, mint: mintMemberInvite };
}
