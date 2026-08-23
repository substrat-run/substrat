import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  platformActorId,
  principalId,
  scopeId,
  tenantId,
  type PermissionKey,
  type PrincipalId,
  type RoleDefinition,
  type ScopeId,
  type TenantId,
  type Page,
} from '@substrat-run/contracts';
import { ulid } from '@substrat-run/kernel';
import { SqliteScopeHost } from '@substrat-run/adapter-sqlite';
import {
  MODULES,
  portalPerms,
  provisionCallout,
  type CalloutInstance,
} from './provision.js';

export { provisionCallout, type CalloutInstance };
import { workorderModule, PERM as WO } from '@substrat-run/engine-workorder';
import { invoicingModule, INVOICING_PERM as INV } from '@substrat-run/engine-invoicing';
import { protocolModule, PROTOCOL_PERM as PROTO } from '@substrat-run/engine-protocol';
import { calloutModule } from './module.js';
import { SC_PERM } from './manifest.js';
import { DEV_PROVIDER, PERSONAS } from './personas.js';

export function buildDemoHost(dir: string): SqliteScopeHost {
  const host = new SqliteScopeHost({ dir }); // default checker: the tuple engine
  for (const m of MODULES) host.registerModule(m);
  return host;
}

/**
 * The demo world: an instance plus the cast and fixtures the story needs.
 *
 * Fixture ids are OPTIONAL. They were required, which meant the type itself
 * asserted that every world contains BRF Grunden — so a real customer's instance
 * could not be a valid `DemoWorld` without inventing one.
 */
export interface DemoWorld extends CalloutInstance {
  t1: TenantId; // ElMontage AB — the same tenant as `tenantId`, kept for the demo's vocabulary
  t2: TenantId; // RörService AB — DEMO ONLY: the other firm the boundary beat turns away
  s1: ScopeId; // Stockholm (ElMontage)
  s2: ScopeId; // Göteborg (RörService) — DEMO ONLY
  anna: PrincipalId; // office-admin, t1 tenant-level
  harald: PrincipalId; // technician @ s1
  berit: PrincipalId; // portal user, customer BRF Grunden
  styrbjorn: PrincipalId; // portal user, customer Kontorshotellet
  mallory: PrincipalId; // office-admin @ t2 — DEMO ONLY: the attacker
  grundenId?: string; // customer BRF Grunden
  kontorshotelletId?: string; // customer Kontorshotellet
  forskolanId?: string; // facility of BRF Grunden
  kontorId?: string; // facility of Kontorshotellet
}

/**
 * The DEMO world: an instance, plus the cast and the story.
 *
 * Everything here that a customer must never receive is grouped and labelled —
 * the second company, the attacker, the fixtures. The cross-tenant-denial beat is
 * genuinely valuable and keeps running; it simply is not part of what provisioning
 * produces.
 */
export async function seedDemo(host: SqliteScopeHost, dir: string): Promise<DemoWorld> {
  const castPath = join(dir, 'cast.json');
  const fresh = !existsSync(castPath);
  const raw: Record<string, string> = fresh
    ? {
        t1: ulid(), t2: ulid(), s1: ulid(), s2: ulid(),
        anna: ulid(), harald: ulid(), berit: ulid(), styrbjorn: ulid(), mallory: ulid(),
        grundenId: '', kontorshotelletId: '', forskolanId: '', kontorId: '',
      }
    : (JSON.parse(readFileSync(castPath, 'utf8')) as Record<string, string>);

  const world: DemoWorld = {
    // The instance half. `t1`/`s1`/`anna` are the demo's names for the same
    // things — a real instance has only the three below.
    tenantId: tenantId.parse(raw.t1),
    scopeId: scopeId.parse(raw.s1),
    owner: principalId.parse(raw.anna),
    t1: tenantId.parse(raw.t1), t2: tenantId.parse(raw.t2),
    s1: scopeId.parse(raw.s1), s2: scopeId.parse(raw.s2),
    anna: principalId.parse(raw.anna), harald: principalId.parse(raw.harald),
    berit: principalId.parse(raw.berit), styrbjorn: principalId.parse(raw.styrbjorn),
    mallory: principalId.parse(raw.mallory),
    grundenId: raw.grundenId ?? '', kontorshotelletId: raw.kontorshotelletId ?? '',
    forskolanId: raw.forskolanId ?? '', kontorId: raw.kontorId ?? '',
  };

  // Control-plane dev actor (control-plane.md §6): locally the platform actor is
  // a stub. Every admin mutation below is stamped with it in the audit trail.
  const staff = platformActorId.parse(ulid());

  // The real instance — everything a customer would get, and nothing else.
  await provisionCallout(host, {
    tenantId: world.t1,
    scopeId: world.s1,
    owner: world.anna,
    slug: 'elmontage',
    name: 'ElMontage AB',
  });
  await host.admin.assignRole(staff, { principalId: world.harald, roleKey: 'technician', node: { tenantId: world.t1, scopeId: world.s1 } });

  // ---------------------------------------------------------------------------
  // DEMO ONLY, below. A second firm and an admin nobody hired, so the scenario
  // can watch the tenant boundary turn them away.
  //
  // #31 blocker 4: this must never be part of provisioning. Instantiating the
  // template would otherwise hand a customer a company they do not own with an
  // admin account they did not create — and since #71 that account has a working
  // login with a known demo password.
  //
  // It lives here rather than in the test file because the dev server's scenario
  // walks the same beat; the test asserting the denial is in test/scenario.test.ts.
  // ---------------------------------------------------------------------------
  await provisionCallout(host, {
    tenantId: world.t2,
    scopeId: world.s2,
    owner: world.mallory,
    slug: 'rorservice',
    name: 'RörService AB',
  });

  if (fresh) {
    const stub = await host.getScope(world.anna, world.t1, world.s1);
    const grunden = await stub.invoke<{ id: string }>('callout/create-customer', {
      number: '1001', name: 'BRF Grunden', orgRef: 'org:brf-grunden',
    });
    const kontorshotellet = await stub.invoke<{ id: string }>('callout/create-customer', {
      number: '1002', name: 'Kontorshotellet AB',
    });
    const forskolan = await stub.invoke<{ id: string }>('callout/create-facility', {
      customerId: grunden.id, name: 'Förskolan Grunden', address: 'Storgatan 1, Stockholm',
      accessNote: 'Portkod 2295. Nyckel till förråd i receptionen.',
    });
    const kontor = await stub.invoke<{ id: string }>('callout/create-facility', {
      customerId: kontorshotellet.id, name: 'Kontorshotellet Vasastan', address: 'Vasagatan 12, Stockholm',
    });
    await stub.invoke('callout/upsert-price', {
      article: 'labor', description: 'Arbetstid', unit: 'tim', priceAmount: '515', minQty: '1.5',
    });
    await stub.invoke('callout/upsert-price', {
      article: 'travel-km', description: 'Restid', unit: 'km', priceAmount: '6', internal: true,
    });
    await stub.invoke('callout/upsert-price', {
      article: 'mat:fan-motor-15w', description: 'Fläktmotor 15W', unit: 'st', priceAmount: '1150',
    });

    world.grundenId = grunden.id;
    world.kontorshotelletId = kontorshotellet.id;
    world.forskolanId = forskolan.id;
    world.kontorId = kontor.id;
    writeFileSync(castPath, JSON.stringify(world, null, 2));
  }

  // Branschprotokoll pack (idempotent, and outside `fresh` so existing demo
  // data gains it on restart): the electrical-trade self-inspection — 100%
  // vertical content; only the invariants are protocol machinery.
  const stub = await host.getScope(world.anna, world.t1, world.s1);
  const { entries: templates } = await stub.invoke<Page<{ key: string }>>('protocol/list-templates');
  if (!templates.some((t) => t.key === 'self-inspection-electrical')) {
    await stub.invoke('protocol/define-template', {
      key: 'self-inspection-electrical',
      title: 'Self-inspection — Elinstallation',
      content: {
        sections: [
          {
            title: 'Före arbete',
            items: [
              { key: 'spanningslost', label: 'Anläggningsdel spänningslös och säkrad mot tillkoppling', type: 'check' },
              { key: 'ritningsunderlag', label: 'Ritningsunderlag och gruppförteckning aktuella', type: 'check' },
            ],
          },
          {
            title: 'Utförande',
            items: [
              { key: 'ledningsdragning', label: 'Ledningsdragning och förläggning enligt SS 436 40 00', type: 'check' },
              { key: 'kapslingsklass', label: 'Kapslingsklass anpassad till miljön', type: 'check' },
            ],
          },
          {
            title: 'Kontroll före idrifttagning',
            items: [
              { key: 'isolationsmatning', label: 'Isolationsmätning', type: 'value', unit: 'MΩ' },
              { key: 'kontinuitet', label: 'Kontinuitetsmätning av skyddsledare', type: 'value', unit: 'Ω' },
              { key: 'jordfelsbrytare', label: 'Jordfelsbrytare provad med testknapp och mätning', type: 'check' },
              { key: 'anmarkningar', label: 'Anmärkningar / avvikelser', type: 'text' },
            ],
          },
        ],
      },
    });
  }

  // ---------------------------------------------------------------------------
  // The login side of the cast: each dev persona's OIDC `sub` bound to its principal
  // in the identity directory. This is the ordinary production seam, not a dev one —
  // a hosted instance builds the same rows when someone claims the owner seat or
  // accepts an invite. All that differs locally is that the subjects are known up
  // front, so nobody has to click through a first-run claim after every data wipe.
  //
  // `scopeId` on the link is what carries a persona to its own node: Mallory resolves
  // into t2/s2 and everyone else into t1/s1, which is how the cross-tenant beat still
  // works without a persona table in the server.
  // ---------------------------------------------------------------------------
  await host.admin.registerIdentityPool(staff, { provider: DEV_PROVIDER, topology: 'central', tenantId: null });
  const homes: Record<string, { principal: PrincipalId; tenantId: TenantId; scopeId: ScopeId }> = {
    'dev|anna': { principal: world.anna, tenantId: world.t1, scopeId: world.s1 },
    'dev|harald': { principal: world.harald, tenantId: world.t1, scopeId: world.s1 },
    'dev|berit': { principal: world.berit, tenantId: world.t1, scopeId: world.s1 },
    'dev|styrbjorn': { principal: world.styrbjorn, tenantId: world.t1, scopeId: world.s1 },
    'dev|mallory': { principal: world.mallory, tenantId: world.t2, scopeId: world.s2 },
  };
  for (const persona of PERSONAS) {
    const home = homes[persona.sub];
    if (!home) continue;
    await host.admin.linkIdentity(staff, {
      provider: DEV_PROVIDER,
      externalId: persona.sub,
      principal: home.principal,
      tenantId: home.tenantId,
      scopeId: home.scopeId,
    });
  }

  // Portal grants (idempotent): entity-narrowed per customer — see ENTITY_GRANTS.
  for (const [principal, customerId] of [
    [world.berit, world.grundenId],
    [world.styrbjorn, world.kontorshotelletId],
  ] as const) {
    if (!customerId) continue;
    for (const permission of portalPerms) {
      await host.admin.grant(staff, {
        principalId: principal, permission,
        node: { tenantId: world.t1, scopeId: world.s1 },
        entity: { entityType: 'customer', entityId: customerId },
        grantedBy: world.anna,
      });
    }
  }

  return world;
}
