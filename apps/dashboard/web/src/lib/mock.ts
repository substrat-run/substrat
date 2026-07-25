import type { AppRow, CatalogEntry, Deployment, GitReposResult, Me, Member, SnapshotRow } from './api';

/**
 * Dev-preview mode — the Dashboard's analogue of the console's `VITE_DEV_ACTOR`
 * seam (apps/console/src/App.tsx). When `VITE_DEV_MOCK` is set at build/dev time,
 * the app skips the OIDC-gated `/api/*` calls and renders against the demo "Acme"
 * tenant, so the whole UI can be built and reviewed without standing up AuthHero.
 * It is NOT authentication and never ships enabled: the real deploy has no
 * `VITE_DEV_MOCK`, so the app always runs the real session + API path there.
 */
export const DEV_MOCK = import.meta.env.VITE_DEV_MOCK === '1' || import.meta.env.VITE_DEV_MOCK === 'true';

export const MOCK_ME: Me = {
  principal: '01J2Q8Z3V9K4W7X2M5N6P7OWNR' as Me['principal'],
  tenant: '01J2Q8Z3V9K4W7X2M5N6P7TNT0' as Me['tenant'],
  dashboardScope: '01J2Q8Z3V9K4W7X2M5N6P7DASH' as Me['dashboardScope'],
  email: 'dana@acme.com',
  name: 'Dana',
  // Two teams so the switcher is exercised in dev-preview (one login, several teams).
  currentTeamId: '01J2Q8Z3V9K4W7X2M5N6P7TNT0' as Me['currentTeamId'],
  teams: [
    { id: '01J2Q8Z3V9K4W7X2M5N6P7TNT0' as Me['tenant'], name: 'Acme', slug: 'acme' },
    { id: '01J2Q8Z3V9K4W7X2M5N6P7TNT1' as Me['tenant'], name: 'Northwind', slug: 'northwind' },
  ],
};

// Mirror the worker's CATALOG map (apps/dashboard/src/worker.ts) — the first-party
// templates a tenant can instantiate, which the live Create App marketplace lists.
export const MOCK_CATALOG: CatalogEntry[] = [
  { slug: 'protocol', name: 'Documents' },
  { slug: 'callout', name: 'Callout' },
];

// A connected GitHub account so the dev-preview shows the live Git-import card shape
// (the real flow redirects to GitHub, which a mock can't do).
export const MOCK_GIT_REPOS: GitReposResult = {
  configured: true,
  connected: true,
  account: 'acme-inc',
  repos: [
    { fullName: 'acme-inc/hr-portal', defaultBranch: 'main', private: true, updatedAt: '2026-07-20T10:00:00Z' },
    { fullName: 'acme-inc/legal-docs', defaultBranch: 'main', private: true, updatedAt: '2026-07-16T09:00:00Z' },
    { fullName: 'acme-inc/field-ops', defaultBranch: 'main', private: false, updatedAt: '2026-07-09T14:00:00Z' },
  ],
};

export const MOCK_MEMBERS: Member[] = [
  { id: 'm1', principal: MOCK_ME.principal, email: 'dana@acme.com', role_key: 'owner', status: 'active', invitation_id: null, invited_by: 'system', invited_at: '2026-03-02T10:00:00Z', joined_at: '2026-03-02T10:00:00Z' },
  { id: 'm2', principal: '01J2Q8Z3V9K4W7X2M5N6P7ADMN', email: 'jonas@acme.com', role_key: 'admin', status: 'active', invitation_id: null, invited_by: 'dana@acme.com', invited_at: '2026-04-11T10:00:00Z', joined_at: '2026-04-12T09:00:00Z' },
  { id: 'm3', principal: null, email: 'priya@acme.com', role_key: 'member', status: 'invited', invitation_id: 'inv-priya', invited_by: 'dana@acme.com', invited_at: '2026-07-20T10:00:00Z', joined_at: null },
];

export const MOCK_DEPLOYMENTS: Deployment[] = [
  {
    slug: 'acme/helpdesk',
    displaySlug: 'helpdesk',
    name: 'Helpdesk',
    source: 'cli',
    versions: [
      { id: '01J2Q8Z3V9K4W7X2M5N6P7V300', version: '0.3.0', admission: 'admitted', admissionNote: null, deploymentRef: 'acme-helpdesk-01j2q8z3v9k4w7x2m5n6p7v300', createdAt: '2026-07-22T12:00:00Z' },
      { id: '01J2Q8Z3V9K4W7X2M5N6P7V200', version: '0.2.0', admission: 'admitted', admissionNote: null, deploymentRef: 'acme-helpdesk-01j2q8z3v9k4w7x2m5n6p7v200', createdAt: '2026-07-20T12:00:00Z' },
      { id: '01J2Q8Z3V9K4W7X2M5N6P7V100', version: '0.1.0', admission: 'pending', admissionNote: null, deploymentRef: 'acme-helpdesk-01j2q8z3v9k4w7x2m5n6p7v100', createdAt: '2026-07-18T12:00:00Z' },
    ],
    channels: [
      { channel: 'prod', versionId: '01J2Q8Z3V9K4W7X2M5N6P7V300' },
      { channel: 'staging', versionId: '01J2Q8Z3V9K4W7X2M5N6P7V300' },
    ],
    // This scope still runs 0.2.0 while prod moved to 0.3.0 — the "update available" state.
    boundVersionId: '01J2Q8Z3V9K4W7X2M5N6P7V200',
  },
  {
    slug: 'acme/reports',
    displaySlug: 'reports',
    name: 'Reports',
    source: 'cli',
    versions: [
      { id: '01J2Q8Z3V9K4W7X2M5N6P7R100', version: '1.0.0', admission: 'pending', admissionNote: null, deploymentRef: 'acme-reports-01j2q8z3v9k4w7x2m5n6p7r100', createdAt: '2026-07-21T12:00:00Z' },
    ],
    channels: [],
  },
];

const now = Date.parse('2026-07-22T18:00:00Z');
const ago = (ms: number) => new Date(now - ms).toISOString();

/** Snapshots of the first mock app: one expiring soon, one pinned. */
export const MOCK_SNAPSHOTS: SnapshotRow[] = [
  {
    id: '01J2Q8Z3V9K4W7X2M5N6P7SN01',
    kind: 'archive',
    forkedFrom: '01J2Q8Z3V9K4W7X2M5N6P789AB',
    forkedAt: ago(26 * 3600e3),
    expiresAt: new Date(now + 5 * 86400e3).toISOString(),
    verticalVersionId: '01J2Q8Z3V9K4W7X2M5N6P7V200',
    createdAt: ago(26 * 3600e3),
    url: 'acme-hr--ssn01.global.substrat.run',
  },
  {
    id: '01J2Q8Z3V9K4W7X2M5N6P7SN02',
    kind: 'archive',
    forkedFrom: '01J2Q8Z3V9K4W7X2M5N6P789AB',
    forkedAt: ago(9 * 86400e3),
    expiresAt: null,
    verticalVersionId: '01J2Q8Z3V9K4W7X2M5N6P7V100',
    createdAt: ago(9 * 86400e3),
  },
];

export const MOCK_APPS: AppRow[] = [
  { id: '1', app_scope_id: '01J2Q8Z3V9K4W7X2M5N6P789AB', vertical_slug: 'protocol', name: 'Acme HR', status: 'active', hostname: 'acme-hr.substrat.run', created_by: 'dana@acme.com', created_at: ago(2 * 3600e3) },
  { id: '2', app_scope_id: '01J2Q8Z3V9K4W7X2M5N6P7LEGA', vertical_slug: 'protocol', name: 'Acme Legal', status: 'active', hostname: 'acme-legal.substrat.run', created_by: 'dana@acme.com', created_at: ago(30 * 3600e3) },
  { id: '3', app_scope_id: '01J2Q8Z3V9K4W7X2M5N6P7FIEL', vertical_slug: 'workorder', name: 'Acme Field Ops', status: 'provisioning', hostname: null, created_by: 'dana@acme.com', created_at: ago(20e3) },
  { id: '4', app_scope_id: '01J2Q8Z3V9K4W7X2M5N6P7FINA', vertical_slug: 'invoicing', name: 'Acme Finance', status: 'failed', hostname: null, created_by: 'dana@acme.com', created_at: ago(3 * 86400e3) },
];
