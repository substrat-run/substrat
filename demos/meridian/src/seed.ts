import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  platformActorId,
  principalId,
  scopeId,
  tenantId,
  type PrincipalId,
  type ScopeId,
  type TenantId,
} from '@substrat-run/contracts';
import { ulid, webCryptoSecretBox, type FetchLike } from '@substrat-run/kernel';
import { SqliteScopeHost } from '@substrat-run/adapter-sqlite';
import { registerScriveConnector } from '@substrat-run/connector-scrive';
import {
  EMPLOYEE_SELF,
  MODULES,
  provisionMeridian,
  VERTICAL,
  type MeridianInstance,
  type ScriveCredential,
} from './provision.js';

/**
 * The demo world and the local (SQLite) host that runs it. The portable half —
 * `provisionMeridian`, `MODULES`, `ROLES`, `connectScrive` — lives in
 * `provision.ts` so the Cloudflare worker can import it without dragging
 * `node:fs`/`better-sqlite3` along. This file is node-only harness.
 */

/**
 * Enabling Scrive on a host: the egress it talks over (the real testbed via the
 * runtime `fetch`, or `ScriveMock` in a test), and the credential every instance's
 * connection seals. Absent, the demo runs exactly as before — the contract sits
 * frozen and pending, which is the honest state without a provider wired.
 */
export interface ScriveConfig {
  fetch?: FetchLike;
  baseUrl?: string;
  secret: ScriveCredential;
}

/**
 * A dev-only key sealing connection secrets at rest. A real deployment supplies
 * its own via `SecretBox`; this exists so the demo can hold a credential locally
 * without shipping one in the clear.
 */
const DEV_SECRET_KEY = new Uint8Array(32).fill(7);

/**
 * Meridian demo world (spec/concept.md §3): one multi-country company
 * (Nordljus AB, SE + ES scopes) and a second company (Solmark AB) that owns the
 * cross-tenant attack victim. Employees are entity-narrowed principals, not a
 * role — their access is a grant on their OWN employee record, exactly like the
 * Callout portal customer.
 */
/** The demo world: an instance, plus the cast and fixtures the story needs. */
export interface DemoWorld extends MeridianInstance {
  t1: TenantId; // Nordljus AB
  t2: TenantId; // Solmark AB (attack victim owner)
  sSe: ScopeId; // Nordljus — Sweden (Stockholm)
  sEs: ScopeId; // Nordljus — Spain (Madrid)
  s2: ScopeId; // Solmark — Sweden
  hedda: PrincipalId; // HR admin, t1 tenant-level (sees both countries)
  mats: PrincipalId; // manager @ sSe
  elin: PrincipalId; // employee @ sSe (entity-narrowed to her own record)
  pablo: PrincipalId; // employee @ sEs
  petra: PrincipalId; // payroll operator @ sSe
  mallory: PrincipalId; // HR admin @ t2 — the attacker
  elinEmpId?: string; // Elin's employee record (sSe)
  karinEmpId?: string; // a second SE employee, no login (directory + denial target)
  matsEmpId?: string; // Mats' own employee record — he is ALSO an employee (dual role)
  pabloEmpId?: string; // Pablo's employee record (sEs)
  projectId?: string; // 'nordljus-app' project (sSe)
}

export function buildDemoHost(dir: string, scrive?: ScriveConfig): SqliteScopeHost {
  const host = new SqliteScopeHost({
    dir,
    // A `SecretBox` is only needed to seal a connection credential — so it is set
    // exactly when Scrive is wired, and the default host (every existing test)
    // still needs none. `fetch` is the connector's egress: the testbed, or a mock.
    ...(scrive
      ? { secretBox: webCryptoSecretBox('meridian-dev', DEV_SECRET_KEY), fetch: scrive.fetch }
      : {}),
  });
  for (const m of MODULES) host.registerModule(m);
  // The connector is host code registered on the scope host, exactly like an
  // engine module — but only when Scrive is enabled, because a registered
  // connector with no connection would fail every dispatch.
  if (scrive) registerScriveConnector(host, { baseUrl: scrive.baseUrl });
  return host;
}

const ONBOARDING_SE = {
  key: 'onboarding-se',
  title: 'Onboarding — Sverige',
  content: {
    sections: [
      {
        title: 'Första dagen',
        items: [
          // 'anstallningsavtal' used to be a checkbox here. It is a signed
          // DOCUMENT now (ANSTALLNINGSAVTAL_SE below) — a checkbox recording
          // that a contract was signed is not evidence that it was.
          { key: 'utrustning', label: 'Dator och passerkort utlämnade', type: 'check' as const },
          { key: 'bankuppgifter', label: 'Bankuppgifter för lön registrerade', type: 'check' as const },
        ],
      },
    ],
  },
};

const ONBOARDING_ES = {
  key: 'onboarding-es',
  title: 'Onboarding — España',
  content: {
    sections: [
      {
        title: 'Primer día',
        items: [
          // 'contrato' moved to ANSTALLNINGSAVTAL_ES for the same reason.
          { key: 'equipo', label: 'Equipo y tarjeta de acceso entregados', type: 'check' as const },
          { key: 'registro_jornada', label: 'Registro de jornada explicado', type: 'check' as const },
        ],
      },
    ],
  },
};

/**
 * The employment contract — a `document` protocol, not a checklist.
 *
 * There are no items. The engine holds a hash and a pointer to
 * `hr_employment_terms`; the terms themselves never leave this vertical.
 *
 * `hashRecipe` is REQUIRED by the engine, and it is the load-bearing half of a
 * document signature: an auditor reading this template years from now must be
 * able to recompute the hash from the vertical's own rows. It has to match
 * `employmentTermsHash()` in module.ts word for word.
 */
const HASH_RECIPE =
  "SHA-256 over, in this exact order, one field per line, each line terminated by \\n: " +
  "'anstallningsavtal/1', 'employee=<employee id>', 'role=<role title>', " +
  "'salary=<monthly salary> <currency>', 'scope=<occupancy pct>', " +
  "'start=<ISO start date>', 'notice=<notice months>'. " +
  'Values are taken verbatim from the latest hr_employment_terms row for the ' +
  'employee; money is a decimal string, never a float. See employmentTermsHash().';

const ANSTALLNINGSAVTAL_SE = {
  key: 'anstallningsavtal-se',
  title: 'Anställningsavtal — Sverige',
  content: {
    kind: 'document' as const,
    documentType: 'anstallningsavtal',
    hashRecipe: HASH_RECIPE,
    description:
      'Signeras av arbetsgivaren och den anställde med BankID via Scrive. Den ' +
      'anställde har normalt inget konto i systemet när avtalet signeras.',
  },
};

const ANSTALLNINGSAVTAL_ES = {
  key: 'anstallningsavtal-es',
  title: 'Contrato de trabajo — España',
  content: {
    kind: 'document' as const,
    documentType: 'anstallningsavtal',
    hashRecipe: HASH_RECIPE,
    description: 'Firmado por la empresa y la persona contratada.',
  },
};

export async function seedDemo(
  host: SqliteScopeHost,
  dir: string,
  scrive?: ScriveCredential,
): Promise<DemoWorld> {
  const castPath = join(dir, 'cast.json');
  const fresh = !existsSync(castPath);
  const raw: Record<string, string> = fresh
    ? {
        t1: ulid(), t2: ulid(), sSe: ulid(), sEs: ulid(), s2: ulid(),
        hedda: ulid(), mats: ulid(), elin: ulid(), pablo: ulid(), petra: ulid(), mallory: ulid(),
        elinEmpId: '', karinEmpId: '', matsEmpId: '', pabloEmpId: '', projectId: '',
      }
    : (JSON.parse(readFileSync(castPath, 'utf8')) as Record<string, string>);

  const world: DemoWorld = {
    tenantId: tenantId.parse(raw.t1),
    scopeId: scopeId.parse(raw.sSe),
    owner: principalId.parse(raw.hedda),
    t1: tenantId.parse(raw.t1), t2: tenantId.parse(raw.t2),
    sSe: scopeId.parse(raw.sSe), sEs: scopeId.parse(raw.sEs), s2: scopeId.parse(raw.s2),
    hedda: principalId.parse(raw.hedda), mats: principalId.parse(raw.mats),
    elin: principalId.parse(raw.elin), pablo: principalId.parse(raw.pablo),
    petra: principalId.parse(raw.petra), mallory: principalId.parse(raw.mallory),
    elinEmpId: raw.elinEmpId ?? '', karinEmpId: raw.karinEmpId ?? '',
    matsEmpId: raw.matsEmpId ?? '', pabloEmpId: raw.pabloEmpId ?? '', projectId: raw.projectId ?? '',
  };

  const staff = platformActorId.parse(ulid());

  // The real instance — everything a customer would get, and nothing else. When
  // Scrive is enabled this also opens the connection, so Karin's contract below
  // dispatches to the provider instead of sitting undelivered.
  await provisionMeridian(
    host,
    { tenantId: world.t1, scopeId: world.sSe, owner: world.hedda, slug: 'nordljus', name: 'Nordljus AB' },
    { scrive },
  );
  // A second scope in the SAME tenant — one company, two countries. Provisioning
  // creates one scope because that is what an instance needs; more are the
  // customer's to add.
  await host.provisionScope(staff, { tenantId: world.t1, scopeId: world.sEs, kind: 'entity', name: 'Spain', jurisdiction: 'eu', vertical: VERTICAL });
  await host.admin.activateScope(staff, world.t1, world.sEs);

  // ---------------------------------------------------------------------------
  // DEMO ONLY, below. A second company and an admin nobody hired, so the scenario
  // can watch the tenant boundary turn them away (#31 blocker 4). Never reachable
  // from provisioning — instantiating the template would otherwise hand a
  // customer a company they do not own with an account they did not create.
  // ---------------------------------------------------------------------------
  await provisionMeridian(host, {
    tenantId: world.t2, scopeId: world.s2, owner: world.mallory,
    slug: 'solmark', name: 'Solmark AB',
  });

  // The demo cast's remaining roles; the tenant-level admins came from provisioning.
  await host.admin.assignRole(staff, { principalId: world.mats, roleKey: 'manager', node: { tenantId: world.t1, scopeId: world.sSe } });
  await host.admin.assignRole(staff, { principalId: world.petra, roleKey: 'payroll', node: { tenantId: world.t1, scopeId: world.sSe } });

  if (fresh) {
    // --- Sweden (Stockholm) ---
    const se = await host.getScope(world.hedda, world.t1, world.sSe);
    await se.invoke('hr/define-leave-type', { key: 'vacation', label: 'Semester', kind: 'vacation', annualDays: '25' });
    await se.invoke('hr/define-leave-type', { key: 'vab', label: 'Vård av barn', kind: 'vab' });
    await se.invoke('hr/define-leave-type', { key: 'sick', label: 'Sjukfrånvaro', kind: 'sick' });
    const elinEmp = await se.invoke<{ id: string }>('hr/create-employee', {
      number: 'SE-001', name: 'Elin Ek', email: 'elin@nordljus.se', nationalId: '19900101-0000', principalRef: world.elin, startedAt: '2024-01-15',
    });
    const karinEmp = await se.invoke<{ id: string }>('hr/create-employee', {
      number: 'SE-002', name: 'Karin Berg', email: 'karin@nordljus.se',
    });
    // Mats is a team lead: a manager (role, above) who is ALSO an employee with
    // his own balance and timesheet — the persona that shows My Work + Manage.
    const matsEmp = await se.invoke<{ id: string }>('hr/create-employee', {
      number: 'SE-003', name: 'Mats Lund', email: 'mats@nordljus.se', principalRef: world.mats, startedAt: '2022-09-01',
    });
    await se.invoke('hr/accrue', { employeeId: elinEmp.id, leaveTypeKey: 'vacation', days: '25' });
    await se.invoke('hr/accrue', { employeeId: matsEmp.id, leaveTypeKey: 'vacation', days: '25' });
    const project = await se.invoke<{ id: string }>('hr/create-project', { code: 'nordljus-app', name: 'Nordljus App' });
    await se.invoke('hr/create-project', { code: 'internal', name: 'Internal' });
    await se.invoke('protocol/define-template', ONBOARDING_SE);
    await se.invoke('protocol/define-template', ANSTALLNINGSAVTAL_SE);
    // Elin is a new hire: start her onboarding checklist so the app opens on the
    // new-hire state. She fills and e-signs it herself through her own grant.
    await se.invoke('hr/start-onboarding', { templateKey: 'onboarding-se', employeeId: elinEmp.id });

    // Karin has been offered a job and has NOT started: no principal_ref, no
    // started_at. Her anställningsavtal is frozen and pending two signatures. With
    // Scrive enabled it is dispatched to the provider and the poll driver records
    // each signature back as it arrives (#96/#97); without it, the contract simply
    // sits pending — the honest state when no provider is wired.
    await se.invoke('hr/set-employment-terms', {
      employeeId: karinEmp.id,
      roleTitle: 'Systemutvecklare',
      monthlySalary: '52000',
      currency: 'SEK',
      scopePct: '100',
      startDate: '2026-09-01',
      noticeMonths: '3',
    });
    await se.invoke('hr/issue-employment-contract', {
      templateKey: 'anstallningsavtal-se',
      employeeId: karinEmp.id,
    });

    // --- Spain (Madrid): different statutory rules, same code ---
    const es = await host.getScope(world.hedda, world.t1, world.sEs);
    await es.invoke('hr/define-leave-type', { key: 'vacation', label: 'Vacaciones', kind: 'vacation', annualDays: '22' });
    await es.invoke('hr/define-leave-type', { key: 'baja', label: 'Baja médica', kind: 'sick' });
    const pabloEmp = await es.invoke<{ id: string }>('hr/create-employee', {
      number: 'ES-001', name: 'Pablo Ruiz', email: 'pablo@nordljus.es', nationalId: '00000000-A', principalRef: world.pablo, startedAt: '2024-03-01',
    });
    await es.invoke('hr/accrue', { employeeId: pabloEmp.id, leaveTypeKey: 'vacation', days: '22' });
    await es.invoke('protocol/define-template', ONBOARDING_ES);
    await es.invoke('protocol/define-template', ANSTALLNINGSAVTAL_ES);

    world.elinEmpId = elinEmp.id;
    world.karinEmpId = karinEmp.id;
    world.matsEmpId = matsEmp.id;
    world.pabloEmpId = pabloEmp.id;
    world.projectId = project.id;
    writeFileSync(castPath, JSON.stringify(world, null, 2));
  }

  // Employee self-service grants (idempotent), entity-narrowed to own record.
  for (const [principal, empId, scope] of [
    [world.elin, world.elinEmpId, world.sSe],
    [world.mats, world.matsEmpId, world.sSe],
    [world.pablo, world.pabloEmpId, world.sEs],
  ] as const) {
    if (!empId) continue;
    for (const permission of EMPLOYEE_SELF) {
      await host.admin.grant(staff, {
        principalId: principal,
        permission,
        node: { tenantId: world.t1, scopeId: scope },
        entity: { entityType: 'employee', entityId: empId },
        grantedBy: world.hedda,
      });
    }
  }

  return world;
}
