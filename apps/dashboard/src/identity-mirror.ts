import type { IdentityLink } from '@substrat-run/contracts';

/**
 * The mirror's divergence, as a fact rather than an assumption (#1343).
 *
 * The dashboard keeps its own identity directory and best-effort mirrors links
 * into the shared one on every `/api/me` (#265). Two sources of truth, healed by
 * polling — and until now the healing was unobservable: the mirror's `catch`
 * swallowed every failure, so "the mirror is complete" was a belief nobody could
 * check from outside. Retiring the local directory (#1343) is a live-data move
 * that cannot be planned against a belief.
 *
 * The comparison is deliberately keyed on `(provider, externalId)` — the pair a
 * login actually resolves by. A link whose PRINCIPAL differs between the two
 * directories is the dangerous case, and it is invisible to a count: both sides
 * have "a link for this user", and the shared one sends them somewhere else.
 */
export interface IdentityDivergence {
  /** Links the dashboard holds that the shared directory does not — the mirror never landed. */
  missing: IdentityLink[];
  /** Links the shared directory holds that the dashboard does not — an unlink that only landed locally. */
  extra: IdentityLink[];
  /** Present in both, resolving to DIFFERENT principals — the case a count cannot see. */
  conflicting: Array<{ local: IdentityLink; shared: IdentityLink }>;
  /** True when all three are empty: the mirror is complete for this tenant, now. */
  inSync: boolean;
}

/**
 * The comparison key, encoded STRUCTURALLY rather than by concatenation.
 *
 * Both halves accept any non-empty string, so a delimiter is only a convention
 * the data can break: with a `US` byte between them, `('a', '\u001fb')` and
 * `('a\u001f', 'b')` are different pairs and were the same key. A collision
 * here does not merely mis-count — it reports a landed link as `missing`, or
 * hides the principal conflict this comparison exists to catch. `JSON.stringify`
 * of the pair is injective: the quote that would forge a boundary is escaped.
 */
const keyOf = (l: { provider: string; externalId: string }): string => JSON.stringify([l.provider, l.externalId]);

/**
 * Compare one tenant's local links against the shared directory's. Pure, so the
 * migration's readiness check and its tests are the same code.
 */
export function deriveIdentityDivergence(
  local: IdentityLink[],
  shared: IdentityLink[],
): IdentityDivergence {
  const sharedBy = new Map(shared.map((l) => [keyOf(l), l]));
  const localBy = new Map(local.map((l) => [keyOf(l), l]));

  const missing: IdentityLink[] = [];
  const conflicting: Array<{ local: IdentityLink; shared: IdentityLink }> = [];
  for (const l of local) {
    const s = sharedBy.get(keyOf(l));
    if (s === undefined) {
      missing.push(l);
      continue;
    }
    // `scopeId` deliberately does NOT count as a conflict: the mirror omits it for
    // a tenant-level home, and a link that resolves to the same principal sends the
    // same person to the same place. Only the principal decides who you become.
    if (s.principal !== l.principal) conflicting.push({ local: l, shared: s });
  }
  const extra = shared.filter((s) => !localBy.has(keyOf(s)));

  return {
    missing,
    extra,
    conflicting,
    inSync: missing.length === 0 && extra.length === 0 && conflicting.length === 0,
  };
}


// ── the mirror step itself, with its dependencies injected ───────────────────

/** What the mirror needs from the SHARED plane — the write half of the seam (#265). */
export interface MirrorPlane {
  ensureTenant(slug: string, name: string): Promise<unknown>;
  getTenant(): Promise<{ name: string } | null | undefined>;
  setTenantName(name: string): Promise<unknown>;
  linkIdentity(link: { provider: string; externalId: string; principal: string; scopeId?: string }): Promise<unknown>;
}

/**
 * Everything one mirror attempt reaches for, as functions, so its failure paths
 * can be driven from a test. `plane()` is a FACTORY on purpose: constructing the
 * tenant-narrowed plane is itself a throwing step — a deployment with no
 * `CONTROL_PLANE_SVC` binding 503s there (#978) — and that throw is exactly the
 * one that used to happen OUTSIDE the mirror's try, escaping into the sign-up,
 * invite-accept or `/api/me` the mirror was riding on.
 */
export interface MirrorDeps {
  readonly provider: string;
  readonly externalId: string;
  readonly tenantId: string;
  team(): Promise<{ slug: string; name: string; status: string } | null | undefined>;
  /** `scopeId` is nullable, not merely absent: a tenant-level home has none. */
  resolve(): Promise<{ principal: string; scopeId?: string | null } | null | undefined>;
  plane(): MirrorPlane;
  log(line: Record<string, unknown>): void;
}

/** What one attempt did. `skipped` is a healthy answer: nothing to mirror yet. */
export type MirrorOutcome = 'mirrored' | 'skipped' | 'failed';

/**
 * Mirror one login's link for one tenant into the shared directory. Best-effort
 * by design: the local link stays authoritative, a plane outage must never fail
 * the request this rides on, and the next `/api/me` retries. Best-effort is not
 * the same as SILENT, which is what #1343 fixes — every failure leaves one
 * structured line behind, the missing-binding 503 included.
 */
export async function mirrorIdentityLink(deps: MirrorDeps): Promise<MirrorOutcome> {
  try {
    const team = await deps.team();
    if (!team || team.status !== 'active') return 'skipped';
    const mapped = await deps.resolve();
    if (!mapped) return 'skipped';
    const plane = deps.plane();
    await plane.ensureTenant(team.slug, team.name);
    // `ensureTenant` is a no-op for an existing row, so a tenant first mirrored at
    // app-provision time keeps its placeholder name (historically the login's email)
    // forever — sync the display name so the CLI's workspace picker shows the team.
    // Read-then-patch to keep the quiet path writeless (this runs on every /api/me).
    const shared = await plane.getTenant();
    if (shared && shared.name !== team.name) await plane.setTenantName(team.name);
    await plane.linkIdentity({
      provider: deps.provider,
      externalId: deps.externalId,
      principal: mapped.principal,
      ...(mapped.scopeId ? { scopeId: mapped.scopeId } : {}),
    });
    return 'mirrored';
  } catch (e) {
    deps.log({
      event: 'dashboard.identity-mirror.failed',
      tenantId: deps.tenantId,
      provider: deps.provider,
      detail: e instanceof Error ? e.message : String(e),
    });
    return 'failed';
  }
}
