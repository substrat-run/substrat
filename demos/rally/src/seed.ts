import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { z } from 'zod';
import { join } from 'node:path';
import {
  definePermissions,
  platformActorId,
  principalId,
  scopeId,
  tenantId,
  orgId as orgIdSchema,
  type OrgId,
  type PermissionKey,
  type PrincipalId,
  type RoleDefinition,
  type ScopeId,
  type TenantId,
} from '@substrat-run/contracts';
import { ulid } from '@substrat-run/kernel';
import { SqliteScopeHost } from '@substrat-run/adapter-sqlite';
import { bookingModule, PERM as BK } from '@substrat-run/engine-booking';
import { invoicingModule, INVOICING_PERM as INV } from '@substrat-run/engine-invoicing';
import { invitesModule, INVITES_PERM as INVITE } from '@substrat-run/engine-invites';
import { rallyModule, RALLY_PERM as RP } from './module.js';

/**
 * What ANY instance of this vertical has: one tenant, one scope, an owner.
 *
 * The boundary #31 blocker 3 is about — everything in RallyWorld beyond these three
 * is the DEMO STORY, which a customer must not receive. Separate types make that
 * structural: `provisionRally` cannot return a cast, because its return type has no
 * room for one.
 */
export interface RallyInstance {
  tenantId: TenantId;
  scopeId: ScopeId;
  /** The first club-admin — whoever provisioned it. */
  owner: PrincipalId;
  /** The club's player org: what membership tuples point at. */
  orgId: OrgId;
}

/** The demo world: an instance, plus the cast and fixtures the story needs. */
export interface RallyWorld extends RallyInstance {
  t1: TenantId; // RallyPoint AB
  t2: TenantId; // Padelcenter Väst AB — the attacker's club
  org1: OrgId; // the club's player org — what a membership tuple points at
  org2: OrgId;
  s1: ScopeId; // Solna venue
  s1b: ScopeId; // Nacka venue (same tenant, second venue)
  s2: ScopeId; // Göteborg (t2)
  astrid: PrincipalId; // club-admin, t1 tenant-level (both venues)
  ravi: PrincipalId; // receptionist @ Solna only
  nils: PrincipalId; // coach @ Solna
  elin: PrincipalId; // player / portal principal
  johan: PrincipalId; // player / portal principal
  rutger: PrincipalId; // club-admin @ t2 — the cross-tenant attacker
  court1?: string; // Solna, Bana 1
  court2?: string; // Solna, Bana 2
  nackaCourt1?: string; // Nacka, Bana A
  nackaCourt2?: string; // Nacka, Bana B
  elinId?: string; // Elin's member record AT SOLNA
  johanId?: string;
  elinNackaId?: string; // …and her separate record at Nacka
  johanNackaId?: string;
  /**
   * The global player refs. One per human, shared across every club they play
   * at — the member rows differ per scope, this does not.
   */
  elinParty?: string;
  johanParty?: string;
}

/**
 * The modules this vertical composes, in registration order. Exported because
 * `tools/permission-diff.mts` renders the permission checkpoint from this same
 * array — emitter and running host read one object, so the artifact cannot drift.
 */
export const MODULES = [bookingModule, invoicingModule, invitesModule, rallyModule];

const adminPerms = [
  RP.browse, RP.wallet, RP.manageVenue, RP.managePricing, RP.manageMembers,
  // A club admin may invite players and withdraw an invitation. Accepting needs
  // no permission at all — the recipient is not a member of anything yet, so the
  // invitation itself is the authority.
  INVITE.send, INVITE.read, INVITE.revoke,
  BK.create, BK.read, BK.hold, BK.confirm, BK.cancel, BK.move, BK.complete, BK.manageResources,
  INV.read, INV.export,
];

/**
 * This vertical's role table. `booking:manage-resources` and `rally:manage-venue`
 * are deliberately withheld from the receptionist: taking a booking is the job,
 * re-cutting the club's hours or courts is not. `booking:move` IS included —
 * rescheduling a customer is reception work — while `booking:cancel` is too,
 * because in this club refunds are handled at the desk. A club wanting those
 * split has a role edit to make, and the diff will show it.
 */
export const ROLES: RoleDefinition[] = [
  { key: 'club-admin', permissions: adminPerms, source: 'vertical' },
  {
    key: 'receptionist',
    permissions: [
      RP.browse, RP.wallet, BK.read, BK.hold, BK.confirm, BK.cancel, BK.move, BK.create,
      // Recording that someone did not turn up is desk work — the flow test
      // caught its absence when reception could book but not close the loop.
      BK.complete,
      RP.manageMembers,
    ],
    source: 'vertical',
  },
  /**
   * DELIBERATELY BROAD — reviewed and accepted at the permission checkpoint
   * (2026-07-18), see spec/concept.md §9.
   *
   * `booking:read` here is the WHOLE venue calendar: every court, every slot, and
   * the member names against them. It is NOT narrowed to the coach's own lessons.
   * Narrowing needs an entity grant minted per coach at runtime, which is a
   * console concern; at this club's size the staff calendar is shared anyway.
   *
   * The line to re-open this on: a club running independent coaches who must not
   * see each other's business. This role is wrong for them.
   */
  { key: 'coach', permissions: [RP.browse, BK.read], source: 'vertical' },
];

/**
 * A player holds NO ROLE — a consumer is not a principal with a role
 * (kernel-design.md §4.3). They hold two kinds of grant instead, and the split
 * is the whole point:
 *
 * SCOPE-WIDE — capabilities that are genuinely public at a club. Seeing which
 * slots are free, and taking a free one, are things any player may do; there is
 * no narrower entity to hang them on, because the court they want is by
 * definition not yet theirs.
 */
const portalScopePerms = [RP.browse, RP.wallet, BK.hold, BK.create];

/**
 * ENTITY-NARROWED to the player's own member record — everything that touches a
 * booking that already exists. `booking:read` scope-wide would hand a player the
 * club's entire book; narrowed, the walk reservation → member reaches only their
 * own. Confirming and cancelling ride the same edge.
 */
const portalEntityPerms = [BK.read, BK.confirm, BK.cancel];

/**
 * Grant SHAPES. The grants themselves are per-principal and minted at runtime, so
 * they can never be a build artifact; their shape can, and it is what tells a
 * reviewer which keys are reachable outside the role table.
 */
export const ENTITY_GRANTS: { entityType: string; permissions: PermissionKey[] }[] = [
  { entityType: 'member', permissions: portalEntityPerms },
  // Not entity-narrowed at all — recorded here so the artifact cannot imply that
  // every non-role capability is entity-bounded. These are scope-wide.
  { entityType: '(scope-wide, no entity)', permissions: portalScopePerms },
];

/**
 * The single typed source for this vertical's permission surface — what the permission
 * checkpoint and `substrat push` read (discovered via `package.json` `substrat.permissions`).
 * Derived from the same `MODULES`/`ROLES` the host registers, so it cannot drift from what runs.
 */
export const permissions = definePermissions({ modules: MODULES, roles: ROLES, entityGrants: ENTITY_GRANTS });

/**
 * Seed one venue. Each scope is its own database, so hours, courts, tiers and
 * price rules are configured per venue — two venues of the same tenant share a
 * role table and nothing else.
 */
async function seedVenue(
  host: SqliteScopeHost,
  actor: PrincipalId,
  tenant: TenantId,
  scope: ScopeId,
  spec: {
    name: string;
    courts: { name: string; durations: string; cover?: 'indoor' | 'covered' | 'open' }[];
    peakAmount: string;
  },
): Promise<string[]> {
  const stub = await host.getScope(actor, tenant, scope);
  await stub.invoke('rally/set-venue', {
    name: spec.name, timezone: 'Europe/Stockholm', holdMinutes: 10,
  });

  // Mon–Fri 07:00–23:00, weekends 08:00–22:00 (0 = Sunday).
  for (const weekday of [1, 2, 3, 4, 5]) {
    await stub.invoke('rally/set-hours', { weekday, opensAt: '07:00', closesAt: '23:00' });
  }
  for (const weekday of [0, 6]) {
    await stub.invoke('rally/set-hours', { weekday, opensAt: '08:00', closesAt: '22:00' });
  }

  const ids: string[] = [];
  for (const c of spec.courts) {
    const court = await stub.invoke<{ id: string }>('booking/create-resource', {
      kind: 'court', name: c.name,
    });
    await stub.invoke('rally/register-court', {
      resourceId: court.id, durations: c.durations, cover: c.cover ?? 'indoor',
    });
    ids.push(court.id);
  }

  // What the club actually sells. No membership discount — padel prices the
  // court, not the customer — so the commercial products are prepaid credit and
  // a subscription that tops it up.
  await stub.invoke('rally/upsert-pack', {
    key: 'klipp-5', title: '5 speltillfällen — betala för 4',
    priceOre: 4 * Number(spec.peakAmount) * 100,
    creditOre: 5 * Number(spec.peakAmount) * 100,
  });
  await stub.invoke('rally/upsert-pack', {
    key: 'klipp-10', title: '10 speltillfällen — betala för 8',
    priceOre: 8 * Number(spec.peakAmount) * 100,
    creditOre: 10 * Number(spec.peakAmount) * 100,
  });
  await stub.invoke('rally/upsert-plan', {
    key: 'manadskort', title: 'Månadskort',
    monthlyOre: 99900, monthlyCreditOre: 120000,
  });

  // PRICING IS A MATRIX, not a base with modifiers.
  //
  // Duration is an input, not a multiplier — a 90-minute peak slot is not
  // reliably 1.5× the 60-minute one — so every (window × duration) pair is
  // priced explicitly. The specificity ladder is a TIE-BREAKER, not a
  // composition: a duration-only rule outranks a time-only rule, so leaving a
  // combination out does not "fall back to peak", it silently sells peak hours
  // at the base rate. The matrix is verbose on purpose.
  const peak = Number(spec.peakAmount);
  const table: { label: string; amount: number; duration: number; from?: string; to?: string;
                 fromDate?: string; toDate?: string }[] = [];
  const perDuration = (
    label: string,
    at: { from?: string; to?: string; fromDate?: string; toDate?: string },
    prices: [number, number, number],
  ) => {
    ([60, 90, 120] as const).forEach((d, i) => {
      table.push({ label: `${label} ${d} min`, amount: prices[i]!, duration: d, ...at });
    });
  };

  perDuration('Bas', {}, [220, 280, 340]);
  perDuration('Högtrafik', { from: '17:00', to: '21:00' }, [peak - 60, peak, peak + 80]);
  // Floodlights, seasonal — see the comment on rally_price_rules.from_date.
  perDuration(
    'Belysning vinter',
    { fromDate: '2026-10-01', toDate: '2027-03-31', from: '15:00', to: '23:00' },
    [peak, peak + 60, peak + 140],
  );
  perDuration(
    'Belysning sommar',
    { fromDate: '2026-04-01', toDate: '2026-09-30', from: '21:00', to: '23:00' },
    [peak, peak + 60, peak + 140],
  );

  for (const r of table) {
    await stub.invoke('rally/upsert-price-rule', {
      label: r.label,
      amount: String(r.amount),
      duration: r.duration,
      ...(r.from ? { fromTime: r.from, toTime: r.to } : {}),
      ...(r.fromDate ? { fromDate: r.fromDate, toDate: r.toDate } : {}),
    });
  }

  return ids;
}

export function buildRallyHost(dir: string): SqliteScopeHost {
  const host = new SqliteScopeHost({ dir }); // default checker: the tuple engine
  for (const m of MODULES) host.registerModule(m);

  /**
   * The connector seam's out-of-band half (K-22 §4.2). Host code, not module
   * code: it holds platform authority, which is exactly what a module must never
   * have — an in-scope write could not reach the directory atomically anyway.
   *
   * A club's membership is a KERNEL fact (this principal belongs to this club);
   * the `rally_members` row the vertical creates on the same event is RallyPoint's
   * own — balances, level, the things a club knows about a player. Two records,
   * two owners, one acceptance.
   */
  host.registerExecutor('rally-member-adder', 'member.add-requested', async (admin, event) => {
    const p = z
      .object({ principal: z.string(), orgId: z.string(), tenantId: z.string() })
      .parse(event.payload);
    await admin.addMember(
      RALLY_PLATFORM_ACTOR,
      tenantId.parse(p.tenantId),
      principalId.parse(p.principal),
      orgIdSchema.parse(p.orgId),
    );
  });
  return host;
}

/**
 * The actor the executor acts as. Platform-side, because effecting a membership
 * is a directory write — the acting PLAYER is recorded on the causing event, and
 * the admin row carries its id (`causedBy`), so the trail still names them.
 */
export const RALLY_PLATFORM_ACTOR = platformActorId.parse('01JZ0000000000000000RA99Y0');

/** Idempotent: safe on every server start; demo data seeds only once. */
/**
 * Provision ONE instance of this vertical — what a customer gets (#31 blocker 3).
 *
 * Tenant, scope, entitlements, roles, identity pool, and an owner holding
 * `club-admin`. No cast, no fixtures, no second company. Idempotent, so it is
 * safe on every start and safe against an instance that already exists.
 *
 * This is the function an instantiate button calls.
 */
export async function provisionRally(
  host: SqliteScopeHost,
  input: {
    tenantId: TenantId;
    scopeId: ScopeId;
    owner: PrincipalId;
    orgId: OrgId;
    slug: string;
    name: string;
  },
): Promise<RallyInstance> {
  const staff = platformActorId.parse(ulid());

  await host.admin.createTenant(staff, { id: input.tenantId, slug: input.slug, name: input.name });
  // K-23: a provider declares its topology before it may link an identity.
  await host.admin.registerIdentityPool(staff, {
    provider: 'better-auth',
    topology: 'central',
    tenantId: null,
  });
  // Entitlements (§4.3) are default-deny, so the SKU flags for the modules this
  // vertical runs must be granted before any of its operations resolve.
  for (const key of ['booking', 'invoicing', 'invites', 'rallypoint']) {
    await host.admin.grantEntitlement(staff, input.tenantId, key);
  }
  await host.provisionScope(staff, {
    tenantId: input.tenantId,
    scopeId: input.scopeId,
    jurisdiction: 'eu',
  });
  // Provisioning writes the row as `provisioning`; nothing may use the scope until
  // it is active (K-31). Here the platform and the vertical are the same process, so
  // the confirmation is immediate — hosted, it arrives from the vertical over a
  // separate call, which is the gap the state exists to make observable.
  await host.admin.activateScope(staff, input.tenantId, input.scopeId);
  for (const role of ROLES) await host.admin.defineRole(staff, input.tenantId, role);
  await host.admin.assignRole(staff, {
    principalId: input.owner,
    roleKey: 'club-admin',
    node: { tenantId: input.tenantId, scopeId: null },
  });
  // A club's player org is part of the instance, not the story: membership tuples
  // point at it and `grantToOrg` targets it, so a club without one cannot admit
  // anybody. Clubs are TENANTS here, which is why each gets its own.
  await host.admin.createOrg(staff, {
    id: input.orgId,
    tenantId: input.tenantId,
    slug: `${input.slug}-players`,
    name: `${input.name} players`,
  });

  return { tenantId: input.tenantId, scopeId: input.scopeId, owner: input.owner, orgId: input.orgId };
}

export async function seedRally(host: SqliteScopeHost, dir: string): Promise<RallyWorld> {
  const castPath = join(dir, 'cast.json');
  const fresh = !existsSync(castPath);
  const raw: Record<string, string> = fresh
    ? {
        t1: ulid(), t2: ulid(), org1: ulid(), org2: ulid(), s1: ulid(), s1b: ulid(), s2: ulid(),
        astrid: ulid(), ravi: ulid(), nils: ulid(), elin: ulid(), johan: ulid(), rutger: ulid(),
        court1: '', court2: '', nackaCourt1: '', nackaCourt2: '',
        elinId: '', johanId: '', elinNackaId: '', johanNackaId: '',
        elinParty: ulid(), johanParty: ulid(),
      }
    : (JSON.parse(readFileSync(castPath, 'utf8')) as Record<string, string>);

  const world: RallyWorld = {
    tenantId: tenantId.parse(raw.t1),
    scopeId: scopeId.parse(raw.s1),
    owner: principalId.parse(raw.astrid),
    orgId: orgIdSchema.parse(raw.org1),
    t1: tenantId.parse(raw.t1), t2: tenantId.parse(raw.t2),
    org1: orgIdSchema.parse(raw.org1), org2: orgIdSchema.parse(raw.org2),
    s1: scopeId.parse(raw.s1), s1b: scopeId.parse(raw.s1b), s2: scopeId.parse(raw.s2),
    astrid: principalId.parse(raw.astrid), ravi: principalId.parse(raw.ravi),
    nils: principalId.parse(raw.nils), elin: principalId.parse(raw.elin),
    johan: principalId.parse(raw.johan), rutger: principalId.parse(raw.rutger),
    court1: raw.court1 ?? '', court2: raw.court2 ?? '',
    nackaCourt1: raw.nackaCourt1 ?? '', nackaCourt2: raw.nackaCourt2 ?? '',
    elinId: raw.elinId ?? '', johanId: raw.johanId ?? '',
    elinNackaId: raw.elinNackaId ?? '', johanNackaId: raw.johanNackaId ?? '',
    elinParty: raw.elinParty!, johanParty: raw.johanParty!,
  };

  const staff = platformActorId.parse(ulid());

  // The real instance — everything a customer would get, and nothing else.
  await provisionRally(host, {
    tenantId: world.t1, scopeId: world.s1, owner: world.astrid, orgId: world.org1,
    slug: 'rallypoint', name: 'RallyPoint AB',
  });
  // A second venue in the SAME club. Provisioning creates one scope because that
  // is what an instance needs; more venues are the club's to add.
  await host.provisionScope(staff, { tenantId: world.t1, scopeId: world.s1b, jurisdiction: 'eu' });
  await host.admin.activateScope(staff, world.t1, world.s1b);

  // ---------------------------------------------------------------------------
  // DEMO ONLY, below. A second club and an admin nobody hired, so the scenario
  // can watch the tenant boundary turn them away (#31 blocker 4). Never reachable
  // from provisioning.
  // ---------------------------------------------------------------------------
  await provisionRally(host, {
    tenantId: world.t2, scopeId: world.s2, owner: world.rutger, orgId: world.org2,
    slug: 'padelcenter-vast', name: 'Padelcenter Väst AB',
  });

  for (const t of [world.t1, world.t2]) {
    for (const role of ROLES) await host.admin.defineRole(staff, t, role);
  }
  // Astrid runs both RallyPoint venues (tenant-level); Ravi only Solna — the
  // "role at many-but-not-all scopes" case the kernel acceptance list wants.
  await host.admin.assignRole(staff, {
    principalId: world.astrid, roleKey: 'club-admin', node: { tenantId: world.t1, scopeId: null },
  });
  await host.admin.assignRole(staff, {
    principalId: world.ravi, roleKey: 'receptionist', node: { tenantId: world.t1, scopeId: world.s1 },
  });
  await host.admin.assignRole(staff, {
    principalId: world.nils, roleKey: 'coach', node: { tenantId: world.t1, scopeId: world.s1 },
  });
  await host.admin.assignRole(staff, {
    principalId: world.rutger, roleKey: 'club-admin', node: { tenantId: world.t2, scopeId: null },
  });

  if (fresh) {
    // Solna and Nacka are two venues of ONE tenant; Göteborg belongs to another
    // company entirely. Astrid's club-admin role is tenant-level, so she reaches
    // both RallyPoint venues and neither of Padelcenter Väst's.
    const solna = await seedVenue(host, world.astrid, world.t1, world.s1, {
      name: 'RallyPoint Solna',
      courts: [
        { name: 'Bana 1', durations: '60,90,120', cover: 'indoor' as const },
        // Bana 2 is 60/90 only — the "durations vary by court" case.
        { name: 'Bana 2', durations: '60,90', cover: 'indoor' as const },
        // Roofed but open-sided: dry, not warm — the case a boolean could not say.
        { name: 'Bana 3 (tak)', durations: '60,90,120', cover: 'covered' as const },
        { name: 'Bana 4 (ute)', durations: '60,90,120', cover: 'open' as const },
      ],
      peakAmount: '340',
    });
    const nacka = await seedVenue(host, world.astrid, world.t1, world.s1b, {
      name: 'RallyPoint Nacka',
      courts: [
        { name: 'Bana A', durations: '60,90,120', cover: 'indoor' as const },
        { name: 'Bana B', durations: '90,120', cover: 'open' as const },
      ],
      peakAmount: '390', // a different venue prices differently
    });
    await seedVenue(host, world.rutger, world.t2, world.s2, {
      name: 'Padelcenter Göteborg',
      courts: [{ name: 'Bana 1', durations: '60,90', cover: 'indoor' as const }],
      peakAmount: '310',
    });

    // The SAME humans, in both RallyPoint venues. Their member record is
    // per-scope — each club's DB holds its own row — but the `party_ref` is one
    // global player identity carried across both. That is the whole cross-club
    // identity story, visible in the seed data.
    for (const [scope, ids] of [
      [world.s1, 'solna'],
      [world.s1b, 'nacka'],
    ] as const) {
      const stub = await host.getScope(world.astrid, world.t1, scope);
      const elin = await stub.invoke<{ id: string }>('rally/create-member', {
        partyRef: world.elinParty, name: 'Elin Kastberg', phone: '070-555 21 09',
        level: '3.4',
      });
      const johan = await stub.invoke<{ id: string }>('rally/create-member', {
        partyRef: world.johanParty, name: 'Johan Ek', level: '3.1',
      });
      if (ids === 'solna') {
        world.elinId = elin.id;
        world.johanId = johan.id;
      } else {
        world.elinNackaId = elin.id;
        world.johanNackaId = johan.id;
      }
    }

    world.court1 = solna[0] ?? '';
    world.court2 = solna[1] ?? '';
    world.nackaCourt1 = nacka[0] ?? '';
    world.nackaCourt2 = nacka[1] ?? '';
    writeFileSync(castPath, JSON.stringify(world, null, 2));
  }

  // Portal grants (idempotent): entity-narrowed per member — see ENTITY_GRANTS.
  // A player is granted per club they belong to. Elin plays at both RallyPoint
  // venues, so she holds a separate pair of grants at each — narrowed to that
  // venue's own member record. She holds nothing at Padelcenter Väst, which is a
  // different company: joining a new club is granting, not a global flag.
  for (const [principal, scope, memberId] of [
    [world.elin, world.s1, world.elinId],
    [world.johan, world.s1, world.johanId],
    [world.elin, world.s1b, world.elinNackaId],
    [world.johan, world.s1b, world.johanNackaId],
  ] as const) {
    if (!memberId) continue;
    for (const permission of portalEntityPerms) {
      await host.admin.grant(staff, {
        principalId: principal,
        permission,
        node: { tenantId: world.t1, scopeId: scope },
        entity: { entityType: 'member', entityId: memberId },
        grantedBy: world.astrid,
      });
    }
    for (const permission of portalScopePerms) {
      await host.admin.grant(staff, {
        principalId: principal,
        permission,
        node: { tenantId: world.t1, scopeId: scope },
        grantedBy: world.astrid,
      });
    }
  }

  return world;
}

/**
 * Bind the demo cast's logins to their principals.
 *
 * Separate from `seedRally` and idempotent, because the auth store is a different
 * database with its own lifecycle: the world may already exist when Better Auth's
 * tables are created fresh, and re-running must not mint a second principal for a
 * person who already has one.
 *
 * A login with no identity in a club resolves to nobody there — that is the point.
 * Signing up makes you a person; joining a club is what the invites engine is for.
 */
export async function linkRallyLogins(
  host: SqliteScopeHost,
  world: RallyWorld,
  users: { externalId: string; principal: PrincipalId; tenantId: TenantId; scopeId: ScopeId }[],
): Promise<void> {
  const staff = RALLY_PLATFORM_ACTOR;
  for (const u of users) {
    if (await host.admin.resolveIdentity(u.tenantId, 'better-auth', u.externalId)) continue;
    await host.admin.linkIdentity(staff, {
      provider: 'better-auth',
      externalId: u.externalId,
      principal: u.principal,
      tenantId: u.tenantId,
      scopeId: u.scopeId,
    });
  }
}
