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
 * It expires `MEMBER_INVITE_TTL_MS` after it is minted, and the inviter is not re-checked at
 * accept: the role was bounded when it was granted, and withdrawing the invite is the lever. An
 * invite minted before #1686 is redeemed the old way, by hash (`claimInvite`).
 *
 * An invite naming an address is for that address (K-61 phase 3): it is accepted only from a
 * session whose issuer verified that address, so a forwarded link opens nothing, and the door
 * admits that person without the link at all (`admitByAddress`). An invite naming no address is
 * the bearer link it always was — what an issuer that verifies no address needs.
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
  BECOME_LINK_STATES_MAX_IDS,
  boundedBecomeMint,
  boundedBecomeRevoke,
  becomeLinkState,
  boundedUnbind,
  boundedBindLinkMint,
  capabilityExchange,
  capabilityId,
  capabilityLabel,
  instant,
  entityRef,
  coverage,
  coverageRefusal,
  principalId,
  z,
  type BoundedBecomeMint,
  type BoundedBecomeRevoke,
  type BecomeLinkState,
  type BoundedUnbind,
  type BoundedBindLinkMint,
  type PrincipalBindLinkInput,
  type EntityRef,
  type CapabilityExchange,
  type CapabilityId,
  type Coverage,
  type MemberInviteLink,
  type PrincipalBecomeCapabilityInput,
  type PrincipalId,
  type Instant,
  type ScopeId,
  type TenantId,
} from '@substrat-run/contracts';
import { capabilityTokenHash, plausibleCapabilitySecret, ulid, type ScopeStub } from '@substrat-run/kernel';
import { redeemBecomeLink } from './become-link.js';
import { verifiedEmailOf } from './oidc-rp-provider.js';
import type { IdentityStub, InviteRow } from './identity-do.js';
import { INVITE_ADDRESS_OPEN } from './member-directory.js';
import { invitePath, sha256Hex } from './owner-claim-link.js';
import { bodyOf } from './request-body.js';

/** The one request-body parser, for a door that mounts its own invite routes beside these (K-61 phase 3). */
export { bodyOf };
import type { AuthProvider } from './provider.js';

/** The slice of the identity directory the invite routes touch. */
export type InviteDirectory = Pick<
  IdentityStub,
  | 'listInvites' | 'getInvite' | 'createInvite' | 'revokeInvite' | 'claimInvite' | 'inviteMatches' | 'claimInviteByCapability'
  | 'inviteLink'
> &
  // Optional so a directory written before #2175 (or K-61 phase 3) still mounts; the identity DO's stub has both.
  Partial<Pick<IdentityStub, 'legacyInviteCount' | 'resolvePrincipal'>>;

/**
 * #2175: the line that measures the legacy hash-only invite branch — one JSON line, `substrat`
 * naming it, ids only.
 * `pending` is the scope's unclaimed hash-only invites (null when the door cannot count them); `via` is the door that wrote it. The list
 * writes it ONLY when `pending > 0`, so a settled period has no line at all; an accept through the
 * legacy branch always writes it, since that is the branch still serving. No address, token or
 * principal — a number and a scope id.
 */
export const legacyInvitesLine = (scopeId: string, pending: number | null, via: 'list' | 'accept') => ({
  substrat: 'legacy-invites-pending' as const,
  level: 'warn' as const,
  scopeId,
  pending,
  via,
  message: 'hash-only member invites are still pending; the legacy accept branch cannot be retired yet',
});

/** The list path reports a scope at most this often, per isolate — it is read often. */
export const LEGACY_INVITES_LIST_REPORT_MS = 60 * 60 * 1000;

/**
 * The list path's report (#2175), for every door that lists pending invites: `count` is asked at
 * most once per scope per `LEGACY_INVITES_LIST_REPORT_MS` of the reporter's life (in memory, per
 * isolate — a restart reports again), and a line is written only when it is above zero, so a
 * settled scope writes nothing and is not throttled. Make one per mount, not per request.
 */
/**
 * Ask for a count without letting the measurement break what it measures: the identity stub is an
 * RPC proxy, so a DO class from before #2175 (mid-deploy) or any throw rejects here. Swallowed —
 * never rethrown — leaving one line that carries no data. Null when it could not be read.
 */
async function countOrNull(count: () => Promise<number>): Promise<number | null> {
  try {
    return await count();
  } catch {
    console.warn('legacy-invites-pending: the count could not be read');
    return null;
  }
}

export function legacyInviteListReporter(opts: { log?: (line: string) => void; now?: () => number } = {}) {
  const log = opts.log ?? ((line: string) => console.warn(line));
  const now = opts.now ?? Date.now;
  const reported = new Map<string, number>();
  const report = async (scopeId: string, count: (() => Promise<number>) | undefined): Promise<void> => {
    // No id, no line: a measurement that cannot name its scope is noise.
    if (!count || !scopeId) return;
    const last = reported.get(scopeId);
    if (last !== undefined && now() - last < LEGACY_INVITES_LIST_REPORT_MS) return;
    // Evict what has aged out, so the map stays the size of the scopes reported this hour.
    for (const [id, at] of reported) if (now() - at >= LEGACY_INVITES_LIST_REPORT_MS) reported.delete(id);
    // Reserve the scope BEFORE awaiting the count: a second list that overlaps this one sees the
    // reservation and returns, so one hour's window yields one count and at most one line. An
    // unreadable count keeps the reservation too (it warned once): a mid-deploy list does not retry per read.
    reported.set(scopeId, now());
    const pending = await countOrNull(count);
    // Absence is the signal: a settled scope writes nothing and is not throttled.
    if (pending === 0) {
      reported.delete(scopeId);
      return;
    }
    if (pending !== null) log(JSON.stringify(legacyInvitesLine(scopeId, pending, 'list')));
  };
  /** Scopes currently remembered — what the eviction keeps bounded. */
  return Object.assign(report, { tracked: () => reported.size });
}

/** The label every member invite's capability carries — what an operator's capability read shows. */
export const MEMBER_INVITE_LABEL = 'member invite';

/**
 * The one refusal an accept answers, whichever step said no. It names the wrong-address case among
 * the others because that one is the person's to fix, by signing in as the address the invite went
 * to; which step refused is still not said.
 */
export const INVITE_REFUSED = 'this invite is invalid, already used, or for another address — sign in with the address it was sent to';

/** How long a member invite stays open: 14 days from its mint. Withdrawing it ends it sooner. */
export const MEMBER_INVITE_TTL_MS = 14 * 24 * 60 * 60 * 1000;

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
  revokeBecomeCapability: (env: E, node: N, capabilityId: CapabilityId, by: PrincipalId) => Promise<BoundedBecomeRevoke>;
  /**
   * Where each named link stands (#1686) — the host's `becomeLinkStates`, in the order asked. What
   * `GET /api/invites` shows beside each invite, so a link the scope revoked or that expired is
   * never listed as open.
   */
  becomeLinkStates: (env: E, node: N, capabilityIds: CapabilityId[]) => Promise<BecomeLinkState[]>;
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
  /** Where the #2175 measurement lines go. Defaults to `console.warn`. */
  log?: (line: string) => void;
  /** The clock the list path's hourly throttle reads. Defaults to `Date.now`. */
  now?: () => number;
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
 *   2. mint its link (#1686): a `become` capability for that principal, single use and expiring
 *      at `expiresAt` (`MEMBER_INVITE_TTL_MS` by default), bounded by what the inviter holds — the
 *      scope's own record, on the spine as `capability.become-minted`. A refusal takes the grant back;
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
    /** `expiresAt` is when the link stops opening, null for never — what the route tells the vertical. */
    record: (principal: PrincipalId, tokenHash: string, capabilityId: CapabilityId, expiresAt: Instant | null) => Promise<void>;
    revokeCapability: (capabilityId: CapabilityId) => Promise<unknown>;
    rollback: (principal: PrincipalId) => Promise<unknown>;
  },
  input: {
    roleKey: string;
    email: string | null;
    origin: string;
    /**
     * When the link stops opening. Omitted: `MEMBER_INVITE_TTL_MS` from now. Null: never, which is
     * what an invite was before K-61 phase 3, kept for a desk flow that has not chosen otherwise.
     */
    expiresAt?: Instant | null;
  },
): Promise<{ ok: true; invite: MemberInviteLink; expiresAt: Instant | null } | { ok: false; coverage: Coverage }> {
  const expiresAt = input.expiresAt === undefined
    ? instant.parse(new Date(Date.now() + MEMBER_INVITE_TTL_MS).toISOString())
    : input.expiresAt;
  const principal = principalId.parse(ulid());
  const bound = coverage.safeParse(await steps.grant(principal));
  if (!bound.success) {
    throw new HTTPException(500, { message: 'the canAssign bound did not answer with a coverage — refusing' });
  }
  if (!bound.data.covered) return { ok: false, coverage: bound.data };
  const ungrant = () => steps.rollback(principal).catch(() => undefined);
  let minted: BoundedBecomeMint;
  try {
    minted = boundedBecomeMint.parse(
      await steps.mint({ principal, maxUses: 1, label: MEMBER_INVITE_LABEL, ...(expiresAt === null ? {} : { expiresAt }) }),
    );
  } catch (err) {
    await ungrant();
    throw err;
  }
  if (!minted.ok) {
    await ungrant();
    // The grant just made is what the principal holds; it holds nothing only when the role
    // carries no permission at all — nothing to invite anyone into. The principal was minted
    // just now, so no link to it can have been exchanged; that refusal is answered all the same.
    if (!('coverage' in minted)) {
      throw new HTTPException(409, {
        message: minted.refused === 'target-holds-nothing'
          ? `'${input.roleKey}' confers nothing here — there is nothing to invite anyone into`
          : 'this invite\'s principal is already claimed — refusing a second link to it',
      });
    }
    return { ok: false, coverage: minted.coverage };
  }
  const link = minted.minted;
  try {
    await steps.record(principal, await capabilityTokenHash(link.secret), link.id, expiresAt);
  } catch (err) {
    await steps.revokeCapability(link.id).catch(() => undefined);
    await ungrant();
    // The directory's one refusal a person can act on (K-61 phase 3), answered as one.
    if (err instanceof Error && err.message.includes(INVITE_ADDRESS_OPEN)) throw new HTTPException(409, { message: INVITE_ADDRESS_OPEN });
    throw err;
  }
  const origin = input.origin.replace(/\/$/, '');
  return {
    ok: true,
    invite: { principal, roleKey: input.roleKey, email: input.email, acceptUrl: `${origin}${invitePath(link.secret)}` },
    expiresAt,
  };
}

/** An open invite as a list shows it (#1686): the row, without its capability id, and where its link stands. */
export type ListedInvite = Omit<InviteRow, 'capabilityId'> & { link: BecomeLinkState | null };

/**
 * Join each invite to where its link stands (#1686), in ONE read of the scope — the list every
 * pending-invite door shows, so a link the scope revoked (its principal's holdings changed) or that
 * expired is never listed as open. A legacy hash-only invite has no link to read: `link: null`.
 */
export async function withLinkStates(
  rows: readonly InviteRow[],
  states: (capabilityIds: CapabilityId[]) => Promise<BecomeLinkState[]>,
): Promise<ListedInvite[]> {
  const ids = rows.flatMap((r) => (r.capabilityId ? [capabilityId.parse(r.capabilityId)] : []));
  // In pages of the read's cap (`BECOME_LINK_STATES_MAX_IDS`), which refuses rather than truncates.
  const read: BecomeLinkState[] = [];
  for (let at = 0; at < ids.length; at += BECOME_LINK_STATES_MAX_IDS) {
    const page = ids.slice(at, at + BECOME_LINK_STATES_MAX_IDS);
    const answer = (await states(page)).map((s) => becomeLinkState.parse(s));
    if (answer.length !== page.length) break;
    read.push(...answer);
  }
  if (read.length !== ids.length) throw new HTTPException(500, { message: 'the scope answered a link state per id it was not asked for — refusing' });
  const byId = new Map(ids.map((id, i) => [id as string, read[i]!]));
  return rows.map(({ capabilityId: id, ...row }) => ({ ...row, link: id ? byId.get(id)! : null }));
}

/**
 * Accept an invite (#1150, #1686) — the one copy every accept door runs. A capability secret is
 * redeemed as every `become` link is (`redeemBecomeLink`): checked against the directory before
 * the scope spends its use, exchanged, then bound only while the row still names that capability
 * and principal. A token that is not a capability secret is a LEGACY hash-only invite, redeemed by
 * hash (`claimInvite`). Null for every refusal, one answer.
 *
 * `verifiedEmail` is the presenting session's verified address (null: none). An invite naming an
 * address other than it — or any address, when it is null — is refused before the scope is asked,
 * so its use stays for the person it names (`addressAdmits`). Omitted, the address is not judged:
 * a desk flow written before K-61 phase 3 keeps the answer it had.
 */
export async function acceptMemberInvite(
  deps: {
    directory: Pick<InviteDirectory, 'claimInvite' | 'inviteMatches' | 'claimInviteByCapability' | 'legacyInviteCount'>;
    exchange: (secret: string) => Promise<CapabilityExchange | null>;
    /** Where the #2175 measurement line goes. Defaults to `console.warn`. */
    log?: (line: string) => void;
  },
  scopeId: string,
  sub: string,
  token: string,
  verifiedEmail?: string | null,
): Promise<string | null> {
  if (!plausibleCapabilitySecret(token)) {
    // LEGACY — a hash-only invite (see `claimInvite`).
    const principal = await deps.directory.claimInvite(scopeId, sub, await sha256Hex(token), verifiedEmail);
    // #2175: a legacy claim that SUCCEEDED proves the branch still serves; the count is what is left.
    // A failed claim or a garbage token writes nothing, so a line always means a real invite.
    const count = deps.directory.legacyInviteCount;
    if (principal && scopeId) {
      const left = count ? await countOrNull(() => count.call(deps.directory, scopeId)) : null;
      (deps.log ?? ((line) => console.warn(line)))(JSON.stringify(legacyInvitesLine(scopeId, left, 'accept')));
    }
    return principal;
  }
  return redeemBecomeLink(
    {
      matches: (hash) => deps.directory.inviteMatches(scopeId, hash, verifiedEmail),
      exchange: deps.exchange,
      bind: (capabilityId, principal) => deps.directory.claimInviteByCapability(scopeId, sub, capabilityId, principal),
    },
    token,
  );
}

/**
 * Admit a signed-in person by the address their issuer verified (K-61 phase 3) — the worker door's
 * half of a member invite, which needs no link. Asked only for a session bound to nobody in the
 * scope, so it never gives a member a second principal. The same three steps a link's redemption
 * takes, with the address standing in for the secret:
 *   1. the directory names the open invite for that address in this scope (`openInviteFor`), and
 *      its capability — newest first if the address was invited twice;
 *   2. the scope exchanges that capability by its id (`exchangeBecomeLinkById`): expiry,
 *      withdrawal, the single use and the invited principal's holdings judged atomically, the
 *      exchange on the spine as `capability.exercised` — so the link in a mail is spent with it;
 *   3. the directory binds, only while the invite still names that capability and principal, and
 *      only a subject still bound to nobody here (`admitInvite`).
 * `principal` is null for every refusal, one answer: the caller answers it as it answers nobody
 * bound. `contested` says an invite named the address and was refused at the exchange or the bind:
 * a second first request racing this one may have bound the subject meanwhile, so a caller asks
 * the directory again then, and only then. It can lose the single use before the winner's binding
 * is written, and is answered as nobody bound once — its next request finds the binding.
 *
 * As strong as the issuer's `email_verified`, and no stronger: the scope trusts what its issuer
 * vouches for (docs/rfc/verified-address.md §5).
 */
export async function admitByAddress(
  deps: {
    directory: Pick<IdentityStub, 'openInviteFor' | 'admitInvite'>;
    exchangeById: (capabilityId: CapabilityId) => Promise<CapabilityExchange | null>;
  },
  scopeId: string,
  sub: string,
  verifiedEmail: string | null,
): Promise<{ principal: string | null; contested: boolean }> {
  const open = await deps.directory.openInviteFor(scopeId, verifiedEmail);
  if (!open) return { principal: null, contested: false };
  const exchanged = capabilityExchange.nullable().parse(await deps.exchangeById(capabilityId.parse(open.capabilityId)));
  if (exchanged?.kind !== 'principal') return { principal: null, contested: true };
  const principal = await deps.directory.admitInvite(scopeId, sub, exchanged.capabilityId, exchanged.principal);
  return { principal, contested: principal === null };
}

/** An open member invite, as the vertical's operations are told about it (K-61 phase 3). */
export interface MemberInvitation {
  /** The invited principal: the one the person is bound to, and the one a withdrawal names. */
  principal: PrincipalId;
  email: string | null;
  roleKey: string;
}

/** What a door names to let its people invite by address (K-61 phase 3): the worker's, or a dev server's. */
export interface MemberInvites {
  /** The roles a person may be invited at — the vertical's own, as the dashboard's member roles are. */
  roles: readonly string[];
  /**
   * The vertical's invite, as the inviter, once the invited principal holds its role and before
   * anything can admit by it: it checks who may invite, records what its screens list, and queues
   * the mail — "sign in with this address", with no link to carry.
   * `(scope, i) => scope.invoke('crm/invite-member', { principal: i.principal, email: i.email, roleKey: i.roleKey })`.
   * A throw takes the platform's half back and is the route's answer.
   *
   * It must not grant anything to `invitation.principal`. The invite's link is judged against what
   * that principal held when it was minted, so a grant made here revokes it, and the person is
   * answered 401 at sign-in. What they hold comes from the role, and from the vertical's join.
   */
  send: (scope: ScopeStub, invitation: MemberInvitation & { email: string; expiresAt: Instant }) => Promise<unknown>;
  /**
   * The vertical's withdrawal, as the caller, before the platform's half is taken: its own check of
   * who may withdraw, and its own record. A throw is the route's answer, and the invite stays open.
   * It must answer an invite it already withdrew as a success, as a join returns the row it already
   * wrote: a withdrawal whose platform half then fails is retried, and runs it again. Also run when
   * the invite's row could not be written after `send` agreed. `email` is null for an invite the
   * dashboard made without one.
   */
  cancel: (scope: ScopeStub, invitation: MemberInvitation) => Promise<unknown>;
}

/** The host verbs the member invite routes run — the scope's own, bounded where a person asks. */
export interface MemberInviteHost {
  /** Does `principal` hold every permission `roleKey` carries here — the early bound a withdrawal asks. */
  canAssign(tenantId: TenantId, scopeId: ScopeId, principal: PrincipalId, roleKey: string): Promise<Coverage>;
  /** The unbounded revoke a fresh invite's rollback prefers, where the host has one (Cloudflare's). */
  revokeScopeRole?(scopeId: ScopeId, principal: PrincipalId, roleKey: string): Promise<unknown>;
  assignScopeRoleBounded(
    tenantId: TenantId, scopeId: ScopeId, caller: PrincipalId, assignee: PrincipalId, roleKey: string,
  ): Promise<Coverage>;
  revokeScopeRolesBounded(
    tenantId: TenantId, scopeId: ScopeId, caller: PrincipalId, principal: PrincipalId,
  ): Promise<{ coverage: Coverage; revoked: string[] }>;
  mintBecomeCapabilityBounded(
    tenantId: TenantId, scopeId: ScopeId, caller: PrincipalId, input: PrincipalBecomeCapabilityInput,
  ): Promise<BoundedBecomeMint>;
  revokeBecomeCapability(tenantId: TenantId, scopeId: ScopeId, capabilityId: CapabilityId, by: PrincipalId): Promise<BoundedBecomeRevoke>;
}

/** What `mountMemberInvites` needs: who is asking, where invites are filed, the host, and the vertical's operations. */
export interface MemberInviteRouteDeps<E extends object, N extends { tenantId: TenantId; scopeId: ScopeId }> {
  /** The caller bound in the routed scope, with their stub: 401 for nobody. */
  signedIn: (c: Context<{ Bindings: E }>) => Promise<{ node: N; principal: PrincipalId; scope: ScopeStub }>;
  /** Where invites are filed: the tenant's identity directory, or a dev server's local copy of it. */
  directory: (env: E, node: N) => Pick<
    IdentityStub,
    'createInvite' | 'getInvite' | 'inviteLink' | 'revokeInvite' | 'unbindPrincipal' | 'openInviteFor'
  >;
  host: (env: E) => MemberInviteHost;
  invites: MemberInvites;
}

/** The body `POST /api/member-invites` takes: an address is required, since it is what admits. */
export const memberInviteBody = z.object({ email: z.string().email(), roleKey: z.string().min(1) });

/**
 * Mount the two member invite routes a door owns (K-61 phase 3) — the worker door's, and a dev
 * server's, so the two cannot drift:
 *
 *   POST /api/member-invites                     { email, roleKey } → 201 { principal, email, roleKey, expiresAt }
 *   POST /api/member-invites/:principal/withdraw                    → 204
 *
 * An address has one open invite at a time: a second is 409, asked before anything is minted or
 * mailed. An invite mints the principal, its role (bounded by the inviter's own) and a link that
 * expires, then runs the vertical's `send` as the inviter, and only after it agrees records the row
 * a door admits by — so an invite the vertical refuses never admits anyone. A withdrawal decides who
 * may withdraw before anything is withdrawn — the platform's bound over the invite's role, then the
 * vertical's `cancel` — then takes the platform's half (roles bounded by every role the invited
 * principal holds, the link, the row) and unbinds anyone admitted meanwhile. No secret leaves
 * either route: the person is admitted by their verified address (`admitByAddress`).
 */
export function mountMemberInvites<E extends object, N extends { tenantId: TenantId; scopeId: ScopeId }>(
  app: Hono<{ Bindings: E }>,
  deps: MemberInviteRouteDeps<E, N>,
): void {
  const { invites } = deps;

  app.post('/api/member-invites', async (c) => {
    const { node, principal: caller, scope } = await deps.signedIn(c);
    const { email, roleKey } = await bodyOf(c, memberInviteBody);
    if (!invites.roles.includes(roleKey)) throw new HTTPException(400, { message: `unknown role '${roleKey}'` });
    const host = deps.host(c.env);
    const directory = deps.directory(c.env, node);
    // One open invite per address (`createInvite` refuses a second): asked before anything is
    // minted or mailed, so a second invite is a plain 409 and not a mail for nothing.
    if (await directory.openInviteFor(node.scopeId, email)) throw new HTTPException(409, { message: INVITE_ADDRESS_OPEN });
    const minted = await mintMemberInvite(
      {
        grant: (assignee) => host.assignScopeRoleBounded(node.tenantId, node.scopeId, caller, assignee, roleKey),
        mint: (link) => host.mintBecomeCapabilityBounded(node.tenantId, node.scopeId, caller, link),
        // The vertical decides BEFORE the row exists: until the row is written nothing can admit
        // anyone by it, so a refusal here leaves nobody bound. A throw from either step takes the
        // link and the grant back (`mintMemberInvite`); a row that cannot be written after the
        // vertical said yes asks the vertical to take its own record back too.
        record: async (principal, tokenHash, link, expiresAt) => {
          const invitation = { principal, email, roleKey };
          await invites.send(scope, { ...invitation, expiresAt: expiresAt! });
          try {
            await directory.createInvite(node.scopeId, principal, roleKey, email, tokenHash, link);
          } catch (err) {
            await invites.cancel(scope, invitation).catch((cause) => {
              console.error(JSON.stringify({ host: 'member-invite-cancel-failed', ...node, principal, message: String(cause) }));
            });
            throw err;
          }
        },
        revokeCapability: (link) => host.revokeBecomeCapability(node.tenantId, node.scopeId, link, caller),
        rollback: async (principal) => {
          // The unbounded revoke where the host has one (Cloudflare's), so a grant just made always
          // goes. Otherwise the inviter's own bounded revoke, which covers what they were just let
          // grant; a refusal there leaves an inert grant (no row, so nobody can bind to it), said.
          if (host.revokeScopeRole) return host.revokeScopeRole(node.scopeId, principal, roleKey);
          const taken = await host.revokeScopeRolesBounded(node.tenantId, node.scopeId, caller, principal);
          if (!taken.coverage.covered) {
            console.error(JSON.stringify({ host: 'member-invite-rollback-refused', ...node, principal, missing: taken.coverage.missing }));
          }
          return taken;
        },
      },
      { roleKey, email, origin: new URL(c.req.url).origin },
    );
    if (!minted.ok) throw uncovered(minted.coverage.missing, roleKey, 'invite at');
    // The link's secret goes no further than this: the person is admitted by their address.
    return c.json({ principal: principalId.parse(minted.invite.principal), email, roleKey, expiresAt: minted.expiresAt }, 201);
  });

  app.post('/api/member-invites/:principal/withdraw', async (c) => {
    const { node, principal: caller, scope } = await deps.signedIn(c);
    const invited = principalId.safeParse(c.req.param('principal'));
    const directory = deps.directory(c.env, node);
    const invite = invited.success ? await directory.getInvite(node.scopeId, invited.data) : null;
    // No open invite: nothing to withdraw, answered as `mountInviteRoutes` answers it.
    if (!invited.success || !invite) return c.body(null, 204);
    const host = deps.host(c.env);
    // Who may withdraw is decided before anything is withdrawn. First the platform's bound, early,
    // over the role the invite was made at — so a caller it would refuse never has the vertical's
    // row changed under an invite that stays open (a role the tenant no longer defines has no
    // bound to ask, and is left to the revoke below). Then the vertical's own check and record.
    const early = await host.canAssign(node.tenantId, node.scopeId, caller, invite.roleKey).catch(() => null);
    if (early && !early.covered) throw uncovered(early.missing, invite.roleKey, 'withdraw an invite at');
    await invites.cancel(scope, { principal: invited.data, email: invite.email, roleKey: invite.roleKey });
    // Then the platform's half: its roles, bounded by every role the invited principal holds now,
    // then its link, then its row (`withdrawMemberInvite`'s order). A failure here leaves the
    // invite open with the vertical's record already withdrawn; a retry runs `cancel` again, which
    // is why it must answer an invite it already withdrew as a success.
    const taken = await host.revokeScopeRolesBounded(node.tenantId, node.scopeId, caller, invited.data);
    if (!taken.coverage.covered) throw uncovered(taken.coverage.missing, invited.data, 'withdraw the invite of');
    await withdrawMemberInvite(
      { directory, revokeCapability: (link) => host.revokeBecomeCapability(node.tenantId, node.scopeId, link, caller) },
      node.scopeId,
      invited.data,
    );
    // Someone admitted by the invite before its row went holds nothing now; the principal was
    // minted for this invite alone, so they go too, as a member removal unbinds.
    await directory.unbindPrincipal(node.scopeId, invited.data);
    return c.body(null, 204);
  });
}

/**
 * Withdraw an invite's link and then its row (#1686), once the caller's bound has taken the
 * roles. The link goes first, named by the row: a revoke that fails leaves the row in place, so
 * the withdrawal fails as a whole and its retry finds the link again — the scope's own record
 * and the directory never part company. Revoking is idempotent, so a retry after a revoke that
 * landed and a delete that did not is the same call. Then the row goes, which stops an accept.
 */
export async function withdrawMemberInvite(
  steps: {
    directory: Pick<InviteDirectory, 'inviteLink' | 'revokeInvite'>;
    revokeCapability: (capabilityId: CapabilityId) => Promise<BoundedBecomeRevoke>;
  },
  scopeId: string,
  principal: string,
): Promise<void> {
  const link = await steps.directory.inviteLink(scopeId, principal);
  if (link) {
    const revoke = boundedBecomeRevoke.parse(await steps.revokeCapability(capabilityId.parse(link)));
    if (!revoke.ok) throw uncovered(revoke.coverage.missing, principal, 'withdraw the link of');
  }
  await steps.directory.revokeInvite(scopeId, principal);
}

/**
 * Mount the four invite routes on a vertical's Hono app:
 *
 *   GET  /api/invites                    → { roles, invites }            (admin)
 *   POST /api/invites                    → 201 { principal, roleKey, email, acceptUrl } (admin)
 *   POST /api/invites/:principal/revoke  → 204                           (admin)
 *   POST /api/accept-invite              → { ok: true, principal }       (a signed-in subject the invite admits)
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
  const log = deps.log ?? ((line: string) => console.warn(line));
  const reportLegacyOnList = legacyInviteListReporter({ log, now: deps.now });

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
    const directory = deps.directory(c.env, node);
    const rows = await directory.listInvites(node.scopeId);
    await reportLegacyOnList(node.scopeId, directory.legacyInviteCount && (() => directory.legacyInviteCount!(node.scopeId)));
    const invites = await withLinkStates(rows, (ids) => deps.becomeLinkStates(c.env, node, ids));
    return c.json({ roles: [...deps.roles], invites });
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

  // INVARIANT (#1150): an accept writes nothing to the scope beyond what its capability's own
  // exchange writes. The role was granted when the invite was minted; accepting only binds the
  // subject in the identity directory, the same Durable Object the platform's member removal
  // withdraws the invite and unbinds in — so a removal and an accept are serialized there, and an
  // accept after a removal finds no invite. A binding invite (#1686) does grant in the scope — its
  // record's shape — but only inside the exchange, which a withdrawal's revoke (made FIRST, in the
  // scope) refuses atomically: the revoke is the removal marker that grant checks.
  app.post('/api/accept-invite', async (c) => {
    const node = await deps.nodeFor(c.req.raw, c.env);
    const subject = await (await deps.authProvider(c.env, c.req.raw)).resolve(c.req.raw.headers);
    if (!subject) throw new HTTPException(401, { message: 'sign in before accepting an invite' });
    const { token } = await bodyOf(c, acceptInviteBody);
    const principal = await acceptMemberInvite(
      { directory: deps.directory(c.env, node), exchange: (secret) => deps.exchangeCapability(c.env, node, secret), log },
      node.scopeId,
      subject.sub,
      token,
      verifiedEmailOf(subject),
    );
    if (!principal) {
      // Already let in: a worker door admits the address an invite names on the person's first
      // request (K-61 phase 3), which an accept page posting its token comes after, so the invite is
      // spent by then. Answer who they are rather than refuse someone who is in. The same read every
      // screen's `/api/me` makes first, so it seats nobody that read would not.
      const own = await deps.directory(c.env, node).resolvePrincipal?.(node.scopeId, subject.sub);
      if (own) return c.json({ ok: true, principal: own });
      throw new HTTPException(400, { message: INVITE_REFUSED });
    }
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

/** What `POST /api/bindings/:entityType/:entityId/unbind` needs (#1686). */
export interface UnbindRouteDeps<E extends object, N extends { scopeId: string }> {
  /** The (tenant, scope) this request addresses — behind the router, from the assertion. */
  nodeFor: (req: Request, env: E) => N | Promise<N>;
  /**
   * Who is asking: throw 401 for nobody. No admin gate beyond it, on purpose — the bound is the
   * binding's own key on that record, judged by the kernel in the write's scope task, so whoever
   * holds it there may unbind and nobody else, whatever their role is called.
   */
  callerOf: (c: Context<{ Bindings: E }>) => Promise<InviteCaller>;
  /** The host's `unbindEntityHolderBounded`: bound and write in one scope task. */
  unbindEntityHolderBounded: (env: E, node: N, caller: PrincipalId, entity: EntityRef) => Promise<BoundedUnbind>;
}

/**
 * Mount the one generic UNBIND route (#1686), the lever beside a binding invite, for every
 * vertical that declares a binding shape:
 *
 *   POST /api/bindings/:entityType/:entityId/unbind  → { unbound: [<principal>, …], revokedLinks: [<capability>, …] }
 *
 * Clears the record's declared principal column and releases everyone holding the record's shape
 * there — found by their marker on the spine, not by the column, so a holder given the shape
 * before the column was ever written (a legacy holder) is released too — tombstoning the marker
 * and everything they hold on the record, with one `entity.holder-unbound` each on the spine.
 * `unbound: []` when nobody held it. Every binding link still pending on the record is revoked in
 * the same transaction and named in `revokedLinks` (#2818; absent from an older host). A caller without the binding's key on the record is refused
 * 403, naming it; a type the scope's reconciled registry does not bind is 404. A person keeps
 * their login and any role; what goes is what the record gave them.
 */
export function mountUnbindRoute<E extends object, N extends { scopeId: string }>(
  app: Hono<{ Bindings: E }>,
  deps: UnbindRouteDeps<E, N>,
): void {
  app.post('/api/bindings/:entityType/:entityId/unbind', async (c) => {
    const node = await deps.nodeFor(c.req.raw, c.env);
    const caller = inviteCaller.safeParse(await deps.callerOf(c));
    if (!caller.success) {
      throw new HTTPException(500, { message: 'the caller gate named no principal — refusing to unbind for nobody' });
    }
    const entity = entityRef.safeParse({ entityType: c.req.param('entityType'), entityId: c.req.param('entityId') });
    if (!entity.success) throw new HTTPException(400, { message: 'not an entity reference' });
    const answer = boundedUnbind.safeParse(await deps.unbindEntityHolderBounded(c.env, node, caller.data.principal, entity.data));
    if (!answer.success) throw new HTTPException(500, { message: 'the unbind did not answer as a bounded unbind — refusing' });
    if (!answer.data.ok) {
      if ('coverage' in answer.data) {
        throw uncovered(answer.data.coverage.missing, `${entity.data.entityType}:${entity.data.entityId}`, 'unbind the person of');
      }
      throw new HTTPException(404, { message: `'${entity.data.entityType}' is not bound to a person here` });
    }
    // A host older than #2818 answers no `revokedLinks` (it revoked none): passed on as absent, never as [].
    const { unbound, revokedLinks } = answer.data;
    return c.json(revokedLinks === undefined ? { unbound } : { unbound, revokedLinks });
  });
}

/** What the bind link routes (#2817) need: the unbind route's node and caller gate, and the host's two verbs. */
export interface BindLinkRouteDeps<E extends object, N extends { scopeId: string }> {
  nodeFor: (req: Request, env: E) => N | Promise<N>;
  /**
   * Who is asking: throw 401 for nobody. On the mint it is the minter, bounded by the binding's
   * key on the record in the kernel; on the accept it is the PRESENTER — the session's own
   * principal, the only one the link may bind.
   */
  callerOf: (c: Context<{ Bindings: E }>) => Promise<InviteCaller>;
  /** The host's `mintBindLinkBounded`: bound and write in one scope task. */
  mintBindLinkBounded: (env: E, node: N, caller: PrincipalId, input: PrincipalBindLinkInput) => Promise<BoundedBindLinkMint>;
  /** The host's `exchangeCapability`, asked for a `bind` link by its presenter. */
  exchangeBindLink: (env: E, node: N, secret: string, presenter: PrincipalId) => Promise<CapabilityExchange | null>;
}

/**
 * SQLite's words for a UNIQUE constraint refusing a write — the same in both scope hosts, which are
 * both SQLite (better-sqlite3 and a Durable Object's storage), and carried across the DO's RPC.
 */
const UNIQUE_REFUSAL = /\bUNIQUE constraint failed\b/;

/** The body the bind link mint takes: the member to bind, and optionally an expiry and a label. */
export const bindLinkBody = z.object({ principal: principalId, expiresAt: instant.optional(), label: capabilityLabel.optional() });

/**
 * Mount the BIND LINK routes (#2817) — how a member who already belongs to the scope comes to hold
 * a record, for every vertical that declares a binding shape. A binding invite binds a principal
 * minted for it; an existing member — an owner who also does the work, a colleague who starts
 * holding a record later — is bound by a link addressed to them, presented from their own session:
 *
 *   POST /api/bindings/:entityType/:entityId/links  { principal, expiresAt?, label? } → 201 { id, token, expiresAt }
 *   POST /api/bindings/accept                        { token } → { principal, bound }
 *
 * A MEMBER is a principal holding at least one permission at the scope's node — through a role or a
 * grant at the scope or tenant level; entity-narrowed grants alone do not make one. The mint is
 * refused 403 for a caller without the binding's key on the record, naming it; 404 for a type the
 * scope does not bind or a record that is not there; 409 for a record already bound or held, or one
 * whose id more than one row carries; 400 for a principal who is no member here. The accept answers
 * 400 for every refusal — an unknown, used, revoked or expired link, one addressed to someone else,
 * a presenter no longer a member, a record bound meanwhile, or the vertical's own UNIQUE constraint
 * on its binding column refusing a second record for that person — so a probe learns nothing. The owner binding themselves mints to their own principal and accepts.
 * A pending link is withdrawn by the unbind route on its record, which revokes it.
 */
export function mountBindLinkRoutes<E extends object, N extends { scopeId: string }>(
  app: Hono<{ Bindings: E }>,
  deps: BindLinkRouteDeps<E, N>,
): void {
  const callerOf = async (c: Context<{ Bindings: E }>, act: string): Promise<PrincipalId> => {
    const caller = inviteCaller.safeParse(await deps.callerOf(c));
    if (!caller.success) throw new HTTPException(500, { message: `the caller gate named no principal — refusing to ${act} for nobody` });
    return caller.data.principal;
  };

  app.post('/api/bindings/:entityType/:entityId/links', async (c) => {
    const node = await deps.nodeFor(c.req.raw, c.env);
    const caller = await callerOf(c, 'mint a bind link');
    const entity = entityRef.safeParse({ entityType: c.req.param('entityType'), entityId: c.req.param('entityId') });
    if (!entity.success) throw new HTTPException(400, { message: 'not an entity reference' });
    const { principal, expiresAt, label } = await bodyOf(c, bindLinkBody);
    const answer = boundedBindLinkMint.safeParse(
      await deps.mintBindLinkBounded(c.env, node, caller, {
        principal,
        entity: entity.data,
        ...(expiresAt === undefined ? {} : { expiresAt }),
        ...(label === undefined ? {} : { label }),
      }),
    );
    if (!answer.success) throw new HTTPException(500, { message: 'the mint did not answer as a bounded bind link mint — refusing' });
    const ref = `${entity.data.entityType}:${entity.data.entityId}`;
    if (!answer.data.ok) {
      if ('coverage' in answer.data) throw uncovered(answer.data.coverage.missing, ref, 'bind a member to');
      const refused = answer.data.refused;
      if (refused === 'target-holds-nothing') throw new HTTPException(400, { message: `${principal} is not a member here` });
      if (refused === 'bind-not-declared') throw new HTTPException(404, { message: `'${entity.data.entityType}' is not bound to a person here` });
      if (refused === 'bind-record-missing') throw new HTTPException(404, { message: `no ${ref} here` });
      if (refused === 'bind-record-ambiguous') {
        throw new HTTPException(409, { message: `more than one row carries ${ref}'s id — the record must be one row before anyone can be bound to it` });
      }
      throw new HTTPException(409, { message: `${ref} is already bound to someone — unbind it first` });
    }
    const { id, secret, expiresAt: expires } = answer.data.minted;
    return c.json({ id, token: secret, expiresAt: expires }, 201);
  });

  app.post('/api/bindings/accept', async (c) => {
    const node = await deps.nodeFor(c.req.raw, c.env);
    const presenter = await callerOf(c, 'accept a bind link');
    const { token } = await bodyOf(c, acceptInviteBody);
    const refused = () => new HTTPException(400, { message: 'this link is invalid or already used' });
    let answer: unknown;
    try {
      answer = await deps.exchangeBindLink(c.env, node, token, presenter);
    } catch (err) {
      // The vertical's own UNIQUE constraint on its binding column (one record per person) refused
      // the bind: the exchange rolled back with its use untaken. A refusal like any other, not a fault.
      if (err instanceof Error && UNIQUE_REFUSAL.test(err.message)) throw refused();
      throw err;
    }
    const exchanged = capabilityExchange.nullable().parse(answer);
    if (exchanged?.kind !== 'principal' || !exchanged.bound) throw refused();
    return c.json({ principal: exchanged.principal, bound: exchanged.bound });
  });
}
