import { manifestEntities, moduleManifest, permissionKey, type EnvVarSpec } from '@substrat-run/contracts';
import { protocolEntities } from '@substrat-run/engine-protocol';
import { meridianEntities } from './entities.js';
import { PERM as ABSENCE_PERM } from '@substrat-run/engine-absence';

// ============================================================================
// The Meridian vertical's declarative surface: the permission keys and the
// manifest metadata (events, entity relations, entitlement). Everything a
// reader needs to grasp the SHAPE of the vertical, with nothing executable —
// operations live in module.ts, the migration journal in migrations.ts.
//
// HR_PERM and the manifest's `permissions` list are the same keys expressed
// twice; keep them side by side so "add a permission" is a single-file edit.
// ============================================================================

/**
 * Meridian's ORDINARY declared environment — the deployment-default half of its auth
 * config (the structured per-scope `substrat:auth` choice always wins over these; see
 * worker.ts `authProviderFor`). Read exclusively through `resolveScopedEnvSpec`
 * (delivered > env > default, #398), so a hosted install's Env-tab override actually
 * takes effect — never via bare `env.X` reads, which can only ever see the shared
 * deployment default. Harness secrets (ROUTER_SECRET, PLATFORM_SECRET, ALLOW_DEV_NODE)
 * are deliberately NOT declared: they are deployment trust anchors, and keeping them out
 * of the spec keeps them out of the per-scope overlay (declared keys are the allow-list).
 *
 * MIRRORED in `package.json` `substrat.envSpec` (what `substrat push` carries — it reads
 * JSON, not TS); `test/envspec.test.ts` fails the build if the two drift.
 */
export const MERIDIAN_ENV: EnvVarSpec[] = [
  {
    key: 'AUTH_PROVIDER',
    label: 'Auth provider',
    description:
      "OIDC-only: the vertical runs no built-in credential store. When no per-scope `substrat:auth` choice is delivered, 'oidc' verifies bearer tokens against OIDC_ISSUER (standalone deploys); anything else leaves the instance without a configured issuer.",
    placeholder: 'oidc',
    default: 'oidc',
    required: false,
    secret: false,
    group: 'Auth',
  },
  {
    key: 'OIDC_ISSUER',
    label: 'OIDC issuer',
    description: "The issuer URL bearer tokens are verified against when the provider is 'oidc'. Covers Supabase, Auth0, AuthHero, Keycloak, …",
    placeholder: 'https://auth.example.com',
    required: false,
    secret: false,
    group: 'Auth',
  },
  {
    key: 'OIDC_AUDIENCE',
    label: 'OIDC audience',
    description: 'Expected `aud` claim of verified bearer tokens (optional; issuer-dependent).',
    placeholder: 'https://api.example.com',
    required: false,
    secret: false,
    group: 'Auth',
  },
];

export const HR_PERM = {
  employeeManage: permissionKey.parse('employee:manage'),
  // The absence:* keys are DECLARED by engine-absence since the §5 extraction
  // (#634) — same strings as ever (permission keys are never renamed), now
  // aliased so ownership is visible at the reference site.
  absenceConfigure: ABSENCE_PERM.configure,
  absenceRequest: ABSENCE_PERM.request,
  absenceApprove: ABSENCE_PERM.approve,
  absenceRead: ABSENCE_PERM.read,
  timeReport: permissionKey.parse('time:report'),
  timeRead: permissionKey.parse('time:read'),
  projectManage: permissionKey.parse('project:manage'),
  expenseSubmit: permissionKey.parse('expense:submit'),
  expenseApprove: permissionKey.parse('expense:approve'),
  expenseRead: permissionKey.parse('expense:read'),
  payrollExport: permissionKey.parse('payroll:export'),
};

export const meridianManifest = moduleManifest.parse({
  id: '@substrat-run/demo-meridian',
  version: '0.0.1',
  kernelContract: '^0.0.1',
  permissions: [
    // absence:* is engine-absence's declared surface now (#634) — this manifest
    // stopped declaring those keys when the ledger moved; the roles still grant them.
    { key: 'employee:manage', description: 'Create and read employee records, including salary/national id (HR admin)' },
    { key: 'time:report', description: 'Log worked hours to a project (employees, narrowed to their own record)' },
    { key: 'time:read', description: 'Read time entries and utilization' },
    { key: 'project:manage', description: 'Manage the projects time books against (HR admin)' },
    { key: 'expense:submit', description: 'Submit an expense (employees, narrowed to their own record)' },
    { key: 'expense:approve', description: 'Approve or reject an expense (managers, HR admin)' },
    { key: 'expense:read', description: 'Read expenses' },
    { key: 'payroll:export', description: 'Generate the variable-pay export and mark expenses exported (payroll operator)' },
  ],
  events: {
    // The absence events (absence.requested/decided/cancelled/expired,
    // absence.entry-recorded) are emitted — and declared — by engine-absence
    // since the extraction; the hr.* spine keeps only what stayed vertical.
    emits: [
      { type: 'hr.employee-created', schemaVersion: 1 },
      { type: 'hr.employment-terms-set', schemaVersion: 1 },
      { type: 'hr.time-logged', schemaVersion: 1 },
      { type: 'hr.expense-submitted', schemaVersion: 1 },
      { type: 'hr.expense-decided', schemaVersion: 1 },
      { type: 'hr.payroll-exported', schemaVersion: 1 },
    ],
    consumes: [],
  },
  migrations: { journalDir: './migrations', compatibleFrom: '0.0.1' },
  // The #383 stale-leave expiry schedule moved to engine-absence's manifest
  // (`absence/expire-stale`) together with the state machine it polices.
  // Entity names checked against the registry (#697); entityRelations DERIVED
  // from the entities' own `parents`, and the engine edge checked against
  // engine-protocol's registry.
  ...manifestEntities(meridianEntities, {
    engines: [protocolEntities],
    attachmentTargets: [{ entityType: 'employee', readPermission: 'absence:read' }],
    // Onboarding checklists (protocol engine) hang off employees; THIS vertical
    // owns that vocabulary, so it declares the permission-walk edge — which is
    // also what lets an employee's own-record grant reach their onboarding fill.
    relations: [{ entityType: 'protocol', parentType: 'employee' }],
  }),
  entitlementKey: 'meridian',
  envSpec: MERIDIAN_ENV,
  // This app can DELEGATE sign-in to an OIDC issuer (manifest `requires`, #427): at
  // install the dashboard offers the tenant's `oidc-issuer` providers to bind — issuer
  // from the provider's hostname, client minted by dynamic registration, delivered as
  // `substrat:auth`. Requiring is an OFFER, not a demand: builtin auth stays the
  // default, and the OIDC_* envSpec above remains the hand-configured fallback for an
  // externally-hosted issuer. Mirrored in `package.json` `substrat.requires`.
  //
  // `scrive` declares the e-sign provider connection this vertical's signing flow
  // dispatches through (dashboard-ui.md §4.8): the dashboard's Integrations tab renders
  // it as connect-or-"missing its settings". Also an offer, never a gate — a dispatch
  // with no live connection settles pending and delivers once connected.
  requires: ['oidc-issuer', 'scrive'],
});
