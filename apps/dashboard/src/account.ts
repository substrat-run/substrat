import type { IdentityMembership, PlatformActorId, TenantId } from '@substrat-run/contracts';
import type { ScopeHost } from '@substrat-run/kernel';
import { VERTICAL, reconcileRoles, type DashboardNode } from './provision.js';

/**
 * Who the signed-in login is, resolved for one request — the preamble of nearly every
 * `/api/*` handler.
 *
 * It lives apart from `worker.ts` for two reasons. It is the hottest path in the
 * worker, and it used to be a chain of directory reads that grew with the number of
 * teams a login is in: `listIdentityTenants`, then a `getTenant` per team, then
 * `resolveIdentity`, `listScopes` and `listRoles` — each an audited read, so two round
 * trips apiece to the one directory Durable Object. A login in ten teams paid ~29 of
 * them, about three seconds, before its handler ran a line. And no suite drives
 * `worker.ts`, so nothing held the resolve to anything; here it is a function of a
 * `ScopeHost`, which a test can hand a real one.
 *
 * The shape now: ONE read (`listIdentityMemberships`) answers which teams, who the
 * login is in each, and where they land. Everything else below is an idempotent
 * self-heal that has to run once per isolate, not once per request.
 */

/** The identity pool every dashboard login links through (AuthHero's `sub`). */
export const PROVIDER = 'authhero';

/** One team the signed-in user belongs to — a tenant, named for the switcher. */
export interface Team {
  id: TenantId;
  name: string;
  slug: string;
}

/**
 * What THIS isolate has already made sure of. Every entry guards idempotent writes
 * whose inputs only change with a deploy — and a deploy is a new isolate, so a memo
 * that lives exactly as long as the isolate is never stale.
 *
 * It is handed in rather than kept at module level because it is a fact about one
 * DIRECTORY: a suite that builds several hosts in one process must not have the
 * second inherit "the pool is registered" from the first. The worker keys it on the
 * directory binding (`resolveMemoFor`).
 */
export interface ResolveMemo {
  /** The central pool is registered — it is never unregistered, so once is enough. */
  pool: boolean;
  /** Tenants whose role set was reconciled against `ROLES` by this isolate. */
  roles: Set<string>;
  /** The builtin catalog was seeded into the registry from `CATALOG` by this isolate. */
  catalog: boolean;
  /** Recently resolved nodes (`resolveAccountNode`), keyed by login + selected team. */
  nodes: Map<string, { node: DashboardNode; userId: string; until: number }>;
}

export const newResolveMemo = (): ResolveMemo => ({ pool: false, roles: new Set(), catalog: false, nodes: new Map() });

const memos = new WeakMap<object, ResolveMemo>();

/** The memo for one directory, keyed on the binding object that reaches it. */
export function resolveMemoFor(directory: object): ResolveMemo {
  let memo = memos.get(directory);
  if (!memo) memos.set(directory, (memo = newResolveMemo()));
  return memo;
}

/** The pool must exist before anything may link through it or ask who is in it (K-23). */
export async function ensureIdentityPool(host: ScopeHost, staff: PlatformActorId, memo: ResolveMemo): Promise<void> {
  if (memo.pool) return;
  await host.admin.registerIdentityPool(staff, { provider: PROVIDER, topology: 'central', tenantId: null });
  memo.pool = true;
}

/** Every team this login is linked into, tenant row and landing scope attached — one read. */
export async function loginMemberships(
  host: ScopeHost,
  staff: PlatformActorId,
  memo: ResolveMemo,
  userId: string,
): Promise<IdentityMembership[]> {
  await ensureIdentityPool(host, staff, memo);
  return host.admin.listIdentityMemberships(staff, PROVIDER, userId);
}

/**
 * A non-active tenant (a deleted organization) never resolves and never lists — belt
 * to the `unlinkIdentity` at delete time, so a lingering identity row can't land
 * anyone in a dead team.
 */
const active = (memberships: readonly IdentityMembership[]): IdentityMembership[] =>
  memberships.filter((m) => m.tenant.status === 'active');

/** The switcher's list: the login's active teams, by display name. */
export function teamsOf(memberships: readonly IdentityMembership[]): Team[] {
  return active(memberships).map((m) => ({ id: m.tenant.id, name: m.tenant.name, slug: m.tenant.slug }));
}

/**
 * Resolve the caller's node for one of their teams — the selected team if they are
 * genuinely a member of it (verified: `selectedTeamId` must be among `memberships`,
 * which the directory answered, never the cookie), else their first/default team.
 * `null` when the caller belongs to no active team, or the chosen team has no
 * dashboard scope.
 */
export async function resolveNode(
  host: ScopeHost,
  staff: PlatformActorId,
  memo: ResolveMemo,
  memberships: readonly IdentityMembership[],
  selectedTeamId: string | undefined,
): Promise<DashboardNode | null> {
  const candidates = active(memberships);
  const m = candidates.find((x) => x.tenant.id === selectedTeamId) ?? candidates[0];
  if (!m) return null;
  const tenantId = m.tenant.id;
  // Both places that link a login (`createTeam`, invite accept) name the team's
  // dashboard scope, so the membership already says where to land. The directory
  // read stays as the fallback for a link that named no scope, or some other one —
  // trusted only when the joined row says it runs THIS vertical.
  const scopeId =
    m.scope?.vertical === VERTICAL
      ? m.scope.id
      : (await host.admin.listScopes(staff, { tenantId, vertical: VERTICAL }))[0]?.id;
  if (!scopeId) return null;
  // Self-heal role drift: a tenant provisioned before a permission was added to a role
  // (e.g. dashboard:manage-integrations) gets its role set brought current here — once
  // per isolate, since `ROLES` is a constant of the deployed code. Marked only after
  // it succeeds, so a failed heal is retried by the next request rather than skipped.
  if (!memo.roles.has(tenantId)) {
    await reconcileRoles(host, staff, tenantId);
    memo.roles.add(tenantId);
  }
  return { tenantId, scopeId, principal: m.principal };
}

/**
 * How long a resolved node may be reused. This one is NOT like the self-heals above: a
 * membership can end while an entry is live, so the number is a revocation window, and
 * it is short on purpose.
 *
 * What the window does and does not cover. In-scope operations re-check permission on
 * every invoke, so a removed member's writes are refused at once whatever this holds.
 * What rides on the resolve ALONE are the control-plane reads, which go out over the
 * service token narrowed to the resolved tenant — for those, this is the authorization,
 * and a removed member can keep reading them until the entry ages out. The routes that
 * end a membership drop the entries they can reach (`forgetLogin`, `forgetTenant`), but
 * only in the isolate that served them; another isolate learns by expiry. Raise this
 * only with that sentence in mind.
 */
export const NODE_TTL_MS = 30_000;

/** Entries past this are dropped wholesale — a bound, not a policy; the TTL is the policy. */
const NODE_CACHE_MAX = 1_000;

const nodeKey = (userId: string, selectedTeamId: string | undefined): string => `${userId}\n${selectedTeamId ?? ''}`;

/**
 * The per-request resolve: a live cached node, else the one directory read. A `null`
 * is never cached — a login with no team is about to create or join one, and must
 * resolve the moment it has.
 */
export async function resolveAccountNode(
  host: ScopeHost,
  staff: PlatformActorId,
  memo: ResolveMemo,
  userId: string,
  selectedTeamId: string | undefined,
  now: number,
): Promise<DashboardNode | null> {
  const key = nodeKey(userId, selectedTeamId);
  const hit = memo.nodes.get(key);
  if (hit && hit.until > now) return hit.node;
  const node = await resolveNode(host, staff, memo, await loginMemberships(host, staff, memo, userId), selectedTeamId);
  rememberNode(memo, userId, selectedTeamId, node, now);
  return node;
}

/** Record a freshly resolved node — also how `/api/me`, which never reads the cache, keeps it warm. */
export function rememberNode(
  memo: ResolveMemo,
  userId: string,
  selectedTeamId: string | undefined,
  node: DashboardNode | null,
  now: number,
): void {
  const key = nodeKey(userId, selectedTeamId);
  if (!node) {
    memo.nodes.delete(key);
    return;
  }
  if (memo.nodes.size >= NODE_CACHE_MAX) memo.nodes.clear();
  memo.nodes.set(key, { node, userId, until: now + NODE_TTL_MS });
}

/** This login's teams changed (created, joined, left, switched): resolve afresh next time. */
export function forgetLogin(memo: ResolveMemo, userId: string): void {
  for (const [key, entry] of memo.nodes) if (entry.userId === userId) memo.nodes.delete(key);
}

/** Somebody's membership of this team ended (removed, or the team deleted): nobody keeps a cached way in. */
export function forgetTenant(memo: ResolveMemo, tenantId: TenantId): void {
  for (const [key, entry] of memo.nodes) if (entry.node.tenantId === tenantId) memo.nodes.delete(key);
}
