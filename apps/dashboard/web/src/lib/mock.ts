import type { AppHostnamesView, AppModelView, AppPermissionsView, AppRow, AuditEntry, CatalogEntry, DeployFailureRow, FailureGroupRow, ReleasesView, ReleaseComparison, TrafficSeries, AppMigrationsView, Deployment, GitReposResult, Me, Member, ObservabilityLogEvent, ObservabilityRow, SnapshotRow, VerticalPreview , AppSchedulesView } from './api';

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
  { slug: 'protocol', name: 'Documents', owned: false, listed: true, source: 'builtin', installable: true },
  { slug: 'callout', name: 'Callout', owned: false, listed: true, source: 'builtin', installable: true },
  // The dev-preview's own pushed verticals (mirrors MOCK_DEPLOYMENTS): one with a prod
  // version (installable), one still pending — so the New-app groups render both states.
  { slug: 'acme/helpdesk', name: 'Helpdesk', owned: true, listed: false, source: 'cli', installable: true },
  { slug: 'acme/reports', name: 'Reports', owned: true, listed: false, source: 'cli', installable: false },
];

// A connected GitHub account so the dev-preview shows the live Git-import card shape
// (the real flow redirects to GitHub, which a mock can't do).
export const MOCK_GIT_REPOS: GitReposResult = {
  configured: true,
  connected: true,
  account: 'acme-inc',
  accounts: ['acme-inc', 'acme-labs'],
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
    owned: true,
    versions: [
      { id: '01J2Q8Z3V9K4W7X2M5N6P7V300', version: '0.3.0', admission: 'admitted', admissionNote: null, deploymentRef: 'acme-helpdesk-01j2q8z3v9k4w7x2m5n6p7v300', origin: { source: 'git', gitRepo: 'acme/helpdesk', gitCommit: '9f2c1d4b8a7e6f5091827364aabbccdd00112233', gitRef: 'main', gate: 'passed' }, createdAt: '2026-07-22T12:00:00Z' },
      { id: '01J2Q8Z3V9K4W7X2M5N6P7V200', version: '0.2.0', admission: 'admitted', admissionNote: null, deploymentRef: 'acme-helpdesk-01j2q8z3v9k4w7x2m5n6p7v200', origin: { source: 'cli', gate: 'skipped' }, createdAt: '2026-07-20T12:00:00Z' },
      { id: '01J2Q8Z3V9K4W7X2M5N6P7V100', version: '0.1.0', admission: 'pending', admissionNote: null, deploymentRef: 'acme-helpdesk-01j2q8z3v9k4w7x2m5n6p7v100', createdAt: '2026-07-18T12:00:00Z' },
      // A 4th version so the dev preview exercises the collapsed list's "All N versions" link.
      { id: '01J2Q8Z3V9K4W7X2M5N6P7V050', version: '0.0.5', admission: 'admitted', admissionNote: null, deploymentRef: 'acme-helpdesk-01j2q8z3v9k4w7x2m5n6p7v050', createdAt: '2026-07-16T12:00:00Z' },
    ],
    channels: [
      { channel: 'prod', versionId: '01J2Q8Z3V9K4W7X2M5N6P7V300' },
    ],
    // This scope still runs 0.2.0 while prod moved to 0.3.0 — the "update available" state.
    boundVersionId: '01J2Q8Z3V9K4W7X2M5N6P7V200',
  },
  {
    slug: 'acme/reports',
    displaySlug: 'reports',
    name: 'Reports',
    source: 'cli',
    owned: true,
    versions: [
      { id: '01J2Q8Z3V9K4W7X2M5N6P7R100', version: '1.0.0', admission: 'pending', admissionNote: null, deploymentRef: 'acme-reports-01j2q8z3v9k4w7x2m5n6p7r100', createdAt: '2026-07-21T12:00:00Z' },
    ],
    channels: [],
  },
];

/**
 * Dev-preview sample for the Permissions tab (#336). Mirrors MOCK_DEPLOYMENTS[0]: the app
 * runs 0.2.0 while prod moved to 0.3.0, so `update` is populated and the tab shows the
 * version-to-version diff — 0.3.0 adds `helpdesk.ticket.reassign`, retires
 * `helpdesk.ticket.escalate`, and widens the `agent` role.
 */
export const MOCK_APP_PERMISSIONS: AppPermissionsView = {
  running: {
    versionId: '01J2Q8Z3V9K4W7X2M5N6P7V200',
    version: '0.2.0',
    registry: {
      permissions: [
        { key: 'helpdesk:ticket-create', description: 'Open a new support ticket', declaredBy: ['helpdesk'] },
        { key: 'helpdesk:ticket-comment', description: 'Add a reply to a ticket', declaredBy: ['helpdesk'] },
        { key: 'helpdesk:ticket-close', description: 'Resolve and close a ticket', declaredBy: ['helpdesk'] },
        { key: 'helpdesk:ticket-escalate', description: 'Escalate a ticket to a supervisor', declaredBy: ['helpdesk'] },
        { key: 'workorder:job-read', description: 'View a linked field job', declaredBy: ['engine-workorder'] },
      ],
      roles: [
        { key: 'agent', permissions: ['helpdesk:ticket-create', 'helpdesk:ticket-comment', 'helpdesk:ticket-close'], source: 'vertical' },
        { key: 'supervisor', permissions: ['helpdesk:ticket-create', 'helpdesk:ticket-comment', 'helpdesk:ticket-close', 'helpdesk:ticket-escalate', 'workorder:job-read'], source: 'vertical' },
      ],
      entityGrants: [
        { entityType: 'ticket', permissions: ['helpdesk:ticket-comment', 'helpdesk:ticket-close'] },
      ],
    },
  },
  update: {
    versionId: '01J2Q8Z3V9K4W7X2M5N6P7V300',
    version: '0.3.0',
    registry: {
      permissions: [
        { key: 'helpdesk:ticket-create', description: 'Open a new support ticket', declaredBy: ['helpdesk'] },
        { key: 'helpdesk:ticket-comment', description: 'Add a public or internal reply to a ticket', declaredBy: ['helpdesk'] },
        { key: 'helpdesk:ticket-close', description: 'Resolve and close a ticket', declaredBy: ['helpdesk'] },
        { key: 'helpdesk:ticket-reassign', description: 'Move a ticket to another agent or queue', declaredBy: ['helpdesk'] },
        { key: 'workorder:job-read', description: 'View a linked field job', declaredBy: ['engine-workorder'] },
      ],
      roles: [
        { key: 'agent', permissions: ['helpdesk:ticket-create', 'helpdesk:ticket-comment', 'helpdesk:ticket-close', 'helpdesk:ticket-reassign'], source: 'vertical' },
        { key: 'supervisor', permissions: ['helpdesk:ticket-create', 'helpdesk:ticket-comment', 'helpdesk:ticket-close', 'helpdesk:ticket-reassign', 'workorder:job-read'], source: 'vertical' },
      ],
      entityGrants: [
        { entityType: 'ticket', permissions: ['helpdesk:ticket-comment', 'helpdesk:ticket-close', 'helpdesk:ticket-reassign'] },
      ],
    },
  },
};

/**
 * Dev-preview sample for the Model tab (#1214). Mirrors MOCK_APP_PERMISSIONS' helpdesk:
 * the running 0.2.0 declares two entities and a ticket lifecycle; no update model, so the
 * tab's running view renders alone.
 */
/** #1232: one healthy, one overdue, one never-run — the preview shows what the panel is FOR. */
export const MOCK_APP_SCHEDULES: AppSchedulesView = {
  running: { versionId: '01J2Q8Z3V9K4W7X2M5N6P7V300', version: '0.3.0' },
  lastSweepAt: new Date(Date.now() - 4 * 60e3).toISOString(),
  // #1272: one fresh, one stale — the stale one is the receipt-bridge alert this
  // whole view exists for, so the preview must show it.
  freshness: [
    {
      eventType: 'ticket.opened',
      moduleId: '@substrat-run/demo-helpdesk',
      withinHours: 24,
      observedAt: new Date(Date.now() - 3 * 3600e3).toISOString(),
      health: 'fresh',
      runs: [
        { id: '01MOCKFRESHA00000000000001', outcome: 'ok', at: new Date(Date.now() - 40 * 60e3).toISOString(), error: null, elapsedMs: null, observedAt: new Date(Date.now() - 3 * 3600e3).toISOString() },
        { id: '01MOCKFRESHA00000000000000', outcome: 'ok', at: new Date(Date.now() - 100 * 60e3).toISOString(), error: null, elapsedMs: null, observedAt: new Date(Date.now() - 4 * 3600e3).toISOString() },
      ],
    },
    {
      eventType: 'receipt.landed',
      moduleId: '@substrat-run/demo-helpdesk',
      withinHours: 24,
      observedAt: new Date(Date.now() - 26 * 3600e3).toISOString(),
      health: 'stale',
      runs: [
        { id: '01MOCKFRESHB00000000000001', outcome: 'failed', at: new Date(Date.now() - 90 * 60e3).toISOString(), error: null, elapsedMs: null, observedAt: new Date(Date.now() - 26 * 3600e3).toISOString() },
        { id: '01MOCKFRESHB00000000000000', outcome: 'ok', at: new Date(Date.now() - 27 * 3600e3).toISOString(), error: null, elapsedMs: null, observedAt: new Date(Date.now() - 27 * 3600e3).toISOString() },
      ],
    },
  ],
  schedules: [
    {
      operation: 'helpdesk/escalate-stale',
      moduleId: '@substrat-run/demo-helpdesk',
      everyMinutes: 60,
      permissions: ['helpdesk:ticket-write'],
      // lastRun IS runs[0] — the panel renders both, and two different "latest"
      // states in the preview would demo a bug, not the feature.
      ...(() => {
        const runs = Array.from({ length: 10 }, (_, i) => ({
          id: `01MOCKSCHEDA${String(9 - i).padStart(14, '0')}`,
          outcome: (i === 6 ? 'failed' : 'ok') as 'ok' | 'failed' | 'skipped',
          at: new Date(Date.now() - (22 + i * 60) * 60e3).toISOString(),
          error: i === 6 ? 'engine refused: period already closed' : null,
          elapsedMs: 300 + i * 5,
        observedAt: null,
        }));
        return { lastRun: runs[0]!, runs };
      })(),
      nextDueAt: new Date(Date.now() + 38 * 60e3).toISOString(),
      health: 'healthy',
    },
    {
      operation: 'helpdesk/daily-digest',
      moduleId: '@substrat-run/demo-helpdesk',
      everyMinutes: 1440,
      permissions: ['helpdesk:digest-send'],
      ...(() => {
        const runs = [
          { id: '01MOCKSCHEDB00000000000001', outcome: 'ok' as const, at: new Date(Date.now() - 27 * 3600e3).toISOString(), error: null, elapsedMs: 1800, observedAt: null },
          { id: '01MOCKSCHEDB00000000000000', outcome: 'ok' as const, at: new Date(Date.now() - 51 * 3600e3).toISOString(), error: null, elapsedMs: 1750, observedAt: null },
        ];
        return { lastRun: runs[0]!, runs };
      })(),
      nextDueAt: new Date(Date.now() - 3 * 3600e3).toISOString(),
      health: 'overdue',
    },
    {
      operation: 'helpdesk/rebuild-index',
      moduleId: '@substrat-run/demo-helpdesk',
      everyMinutes: 10080,
      permissions: [],
      lastRun: null,
      nextDueAt: null,
      health: 'never-run',
      runs: [],
    },
  ],
};

export const MOCK_APP_MODEL: AppModelView = {
  running: {
    versionId: '01J2Q8Z3V9K4W7X2M5N6P7V200',
    version: '0.2.0',
    model: {
      entities: {
        ticket: {
          table: 'helpdesk_tickets',
          fields: {
            type: 'object',
            properties: {
              id: { type: 'string' },
              queue_id: { type: 'string' },
              subject: { type: 'string' },
              requester_email: { type: 'string' },
              status: { enum: ['open', 'pending', 'closed'] },
            },
            required: ['id', 'queue_id', 'subject', 'requester_email', 'status'],
          },
          parents: ['queue'],
          erasable: ['requester_email'],
        },
        queue: {
          table: 'helpdesk_queues',
          fields: {
            type: 'object',
            properties: { id: { type: 'string' }, name: { type: 'string' } },
            required: ['id', 'name'],
          },
        },
      },
      lifecycles: {
        ticket: {
          field: 'status',
          initial: 'open',
          states: {
            open: { on: { 'helpdesk/close': 'closed', 'helpdesk/await-reply': 'pending' } },
            pending: { on: { 'helpdesk/close': 'closed' } },
            closed: {},
          },
        },
      },
    },
  },
  update: null,
};

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

/** Previews/Environments sample for a mock vertical: a pinned test env on a custom domain + a live PR preview. */
export const MOCK_PREVIEWS: VerticalPreview[] = [
  {
    scopeId: '01J2Q8Z3V9K4W7X2M5N6P7PV01',
    tag: 'test',
    versionId: '01J2Q8Z3V9K4W7X2M5N6P7V200',
    forkedFrom: '01J2Q8Z3V9K4W7X2M5N6P789AB',
    expiresAt: null, // pinned — a long-lived test environment
    hostname: 'crm-test.acme.example',
    url: 'https://crm-test.acme.example',
  },
  {
    scopeId: '01J2Q8Z3V9K4W7X2M5N6P7PV02',
    tag: 'pr-42',
    versionId: '01J2Q8Z3V9K4W7X2M5N6P7V210',
    forkedFrom: '01J2Q8Z3V9K4W7X2M5N6P789AB',
    expiresAt: new Date(now + 2 * 86400e3).toISOString(),
    hostname: 'acme-hr--pr-42.global.substrat.run',
    url: 'https://acme-hr--pr-42.global.substrat.run',
  },
];

/** Schema history (#1236): two module migrations, newest first. */
export const MOCK_APP_MIGRATIONS: AppMigrationsView = { available: true, migrations: [
  { moduleId: 'crm', version: '0003-add-owner-index', appliedAt: ago(2 * 86400e3) },
  { moduleId: 'crm', version: '0002-contacts', appliedAt: ago(9 * 86400e3) },
  { moduleId: 'crm', version: '0001-init', appliedAt: null },
] };

/** Traffic with deploys drawn on it (#1236): the push at hour 18 spikes the errors. */
export const MOCK_TRAFFIC: TrafficSeries = (() => {
  const now = Date.now();
  const buckets = Array.from({ length: 24 }, (_, i) => {
    const t = now - (23 - i) * 3600e3;
    const busy = i > 6 && i < 21;
    return {
      start: new Date(Math.floor(t / 3600e3) * 3600e3).toISOString(),
      requests: busy ? 60 + ((i * 37) % 45) : 8 + ((i * 11) % 9),
      errors: i >= 18 && i <= 20 ? 14 + ((i * 5) % 7) : i % 7 === 0 ? 1 : 0,
    };
  });
  return {
    buckets,
    markers: [
      { at: buckets[18]!.start, kind: 'pushed' as const, version: '0.0.12', versionId: '01J2Q8Z3V9K4W7X2M5N6P7VR03' },
      { at: buckets[6]!.start, kind: 'went-live' as const, version: '0.0.11', versionId: '01J2Q8Z3V9K4W7X2M5N6P7VR02' },
    ].sort((a, b) => (a.at < b.at ? -1 : 1)),
    bucketMinutes: 60,
    available: true,
  };
})();

/** Running vs update (#1236): the update fixes the error rate but costs some p99. */
export const MOCK_RELEASE_COMPARISON: ReleaseComparison = {
  running: {
    versionId: '01J2Q8Z3V9K4W7X2M5N6P7VR01',
    version: '0.0.10',
    requests: 122,
    errors: 61,
    cpuTimeP50: 4.1,
    cpuTimeP99: 18.2,
  },
  update: {
    versionId: '01J2Q8Z3V9K4W7X2M5N6P7VR02',
    version: '0.0.11',
    requests: 1810,
    errors: 2,
    cpuTimeP50: 4.4,
    cpuTimeP99: 24.9,
  },
  metricsAvailable: true,
  owned: true,
};

/** The release ledger (#1236): prod trails the newest push; one scope still pinned back. */
export const MOCK_RELEASES: ReleasesView = {
  releases: [
    {
      versionId: '01J2Q8Z3V9K4W7X2M5N6P7VR03',
      version: '0.0.12',
      pushedAt: ago(2 * 3600e3),
      origin: 'git',
      schemaChange: true,
      wentLiveAt: null,
      isProd: false,
      isServing: false,
      scopesPinned: 0,
      failures: 1,
      requests: 40,
      errors: 3,
    },
    {
      versionId: '01J2Q8Z3V9K4W7X2M5N6P7VR02',
      version: '0.0.11',
      pushedAt: ago(3 * 86400e3),
      origin: 'git',
      schemaChange: false,
      wentLiveAt: ago(2 * 86400e3),
      isProd: true,
      isServing: true,
      scopesPinned: 2,
      failures: 0,
      requests: 1810,
      errors: 2,
    },
    {
      versionId: '01J2Q8Z3V9K4W7X2M5N6P7VR01',
      version: '0.0.10',
      pushedAt: ago(9 * 86400e3),
      origin: 'cli',
      schemaChange: false,
      wentLiveAt: ago(8 * 86400e3),
      isProd: false,
      isServing: false,
      scopesPinned: 1,
      failures: 4,
      requests: 122,
      errors: 61,
    },
  ],
  scopesTrackingProd: 3,
  metricsAvailable: true,
};

/** Failure groups (#1233): the same shapes counted — the preview restore recurs. */
export const MOCK_FAILURE_GROUPS: FailureGroupRow[] = [
  {
    fingerprint: 'preview.create\u001frestore\u001funavailable',
    operation: 'preview.create',
    stage: 'restore',
    code: 'unavailable',
    origin: 'platform',
    count: 4,
    firstSeen: ago(6 * 86400e3),
    lastSeen: ago(3 * 3600e3),
    lastMessage: 'internal error; reference = 242sg7l0st8ldln5uqu8ei58',
    lastStatus: 502,
  },
  {
    fingerprint: 'deploy.upload\u001fwfp-upload\u001f',
    operation: 'deploy.upload',
    stage: 'wfp-upload',
    code: null,
    origin: 'provider',
    count: 1,
    firstSeen: ago(2 * 86400e3),
    lastSeen: ago(2 * 86400e3),
    lastMessage: 'deploy rejected: Uncaught Error at module top level (CF 10021)',
    lastStatus: 422,
  },
];

/** Deploy-failures sample (#559): a platform fault during a preview restore + a rejected bundle. */
export const MOCK_FAILURES: DeployFailureRow[] = [
  {
    id: '01J2Q8Z3V9K4W7X2M5N6P7FL01',
    operation: 'preview.create',
    stage: 'restore',
    scopeId: '01J2Q8Z3V9K4W7X2M5N6P7PV02',
    status: 502,
    message: 'internal error; reference = 242sg7l0st8ldln5uqu8ei58',
    reference: '242sg7l0st8ldln5uqu8ei58',
    at: ago(3 * 3600e3),
  },
  {
    id: '01J2Q8Z3V9K4W7X2M5N6P7FL02',
    operation: 'deploy.upload',
    stage: 'wfp-upload',
    scopeId: null,
    status: 422,
    message: 'deploy rejected: Uncaught Error at module top level (CF 10021)',
    reference: null,
    at: ago(2 * 86400e3),
  },
];

/** Domains-tab sample for the first mock app: default + a second surface + a pending custom domain. */
export const MOCK_APP_HOSTNAMES: AppHostnamesView = {
  bindings: [
    { hostname: 'acme-hr.substrat.run', surface: 'app', status: 'active', statusNote: null, canonical: true, createdAt: ago(30 * 86400e3), validationRecords: [] },
    { hostname: 'acme-hr-eka.substrat.run', surface: 'eka', status: 'active', statusNote: null, canonical: true, createdAt: ago(2 * 86400e3), validationRecords: [] },
    {
      hostname: 'hr.acme.com', surface: 'app', status: 'verifying', statusNote: null, canonical: false, createdAt: ago(3600e3),
      validationRecords: [{ type: 'hostname', name: 'hr.acme.com', value: 'edge.substrat.run', status: 'pending' }],
    },
    {
      hostname: 'legal.acme.com', surface: 'app', status: 'failed',
      statusNote: 'DNS validation timed out — the CNAME does not resolve yet.', canonical: false, createdAt: ago(7200e3),
      validationRecords: [{ type: 'hostname', name: 'legal.acme.com', value: 'edge.substrat.run', status: 'pending' }],
    },
  ],
  surfaces: [
    { name: 'app', label: 'Acme HR' },
    { name: 'eka', label: 'Economy admin' },
  ],
  defaultHostname: 'acme-hr.substrat.run',
};

export const MOCK_APPS: AppRow[] = [
  { id: '1', app_scope_id: '01J2Q8Z3V9K4W7X2M5N6P789AB', vertical_slug: 'protocol', name: 'Acme HR', status: 'active', hostname: 'acme-hr.substrat.run', created_by: 'dana@acme.com', created_at: ago(2 * 3600e3) },
  { id: '2', app_scope_id: '01J2Q8Z3V9K4W7X2M5N6P7LEGA', vertical_slug: 'protocol', name: 'Acme Legal', status: 'active', hostname: 'acme-legal.substrat.run', created_by: 'dana@acme.com', created_at: ago(30 * 3600e3) },
  { id: '3', app_scope_id: '01J2Q8Z3V9K4W7X2M5N6P7FIEL', vertical_slug: 'workorder', name: 'Acme Field Ops', status: 'provisioning', hostname: null, created_by: 'dana@acme.com', created_at: ago(20e3) },
  { id: '4', app_scope_id: '01J2Q8Z3V9K4W7X2M5N6P7FINA', vertical_slug: 'invoicing', name: 'Acme Finance', status: 'failed', hostname: null, created_by: 'dana@acme.com', created_at: ago(3 * 86400e3) },
];

/** Traffic for the mock deployments' deployed versions (matches MOCK_DEPLOYMENTS refs). */
export const MOCK_OBSERVABILITY: ObservabilityRow[] = [
  { vertical: 'acme/helpdesk', version: '0.3.0', versionId: '01J2Q8Z3V9K4W7X2M5N6P7V300', service: 'acme-helpdesk-01j2q8z3v9k4w7x2m5n6p7v300', requests: 12840, errors: 23, subrequests: 31200, cpuTimeP50: 2400, cpuTimeP99: 18200 },
  { vertical: 'acme/helpdesk', version: '0.2.0', versionId: '01J2Q8Z3V9K4W7X2M5N6P7V200', service: 'acme-helpdesk-01j2q8z3v9k4w7x2m5n6p7v200', requests: 3120, errors: 1, subrequests: 7400, cpuTimeP50: 2100, cpuTimeP99: 15400 },
];

/**
 * Dev-preview sample for the Audit tab — a scope's control-plane admin log, newest
 * first. Real rows come from `GET /api/apps/:scopeId/audit`; this only lets the tab
 * be built and reviewed without a live control plane. Scope id matches MOCK_APPS[0].
 */
export const MOCK_AUDIT_ENTRIES: AuditEntry[] = [
  { id: '01J2Q8ZAUDIT000000000000A9', actor: 'dana@acme.com', action: 'assignRole', tenantId: '01J2Q8Z3V9K4W7X2M5N6P7TNT0', scopeId: '01J2Q8Z3V9K4W7X2M5N6P789AB', vertical: 'protocol', before: null, after: { principal: '01J2Q8…MBER2', role: 'editor' }, causedBy: null, at: ago(90 * 60e3) },
  { id: '01J2Q8ZAUDIT000000000000A8', actor: 'service:control-plane', action: 'bindScopeVersion', tenantId: '01J2Q8Z3V9K4W7X2M5N6P7TNT0', scopeId: '01J2Q8Z3V9K4W7X2M5N6P789AB', vertical: 'protocol', before: { versionId: '01J2Q8…V030' }, after: { versionId: '01J2Q8…V040' }, causedBy: '01J2Q8Z3EVENT00000000DEPLOY', at: ago(4 * 3600e3) },
  { id: '01J2Q8ZAUDIT000000000000A7', actor: 'service:control-plane', action: 'setHostnameStatus', tenantId: '01J2Q8Z3V9K4W7X2M5N6P7TNT0', scopeId: '01J2Q8Z3V9K4W7X2M5N6P789AB', vertical: null, before: { status: 'pending' }, after: { status: 'active', hostname: 'acme-hr.substrat.run' }, causedBy: null, at: ago(26 * 3600e3) },
  { id: '01J2Q8ZAUDIT000000000000A6', actor: 'dana@acme.com', action: 'grantEntitlement', tenantId: '01J2Q8Z3V9K4W7X2M5N6P7TNT0', scopeId: '01J2Q8Z3V9K4W7X2M5N6P789AB', vertical: null, before: null, after: { key: 'protocol.pro' }, causedBy: null, at: ago(2 * 86400e3) },
  { id: '01J2Q8ZAUDIT000000000000A5', actor: 'service:control-plane', action: 'provisionScope', tenantId: '01J2Q8Z3V9K4W7X2M5N6P7TNT0', scopeId: '01J2Q8Z3V9K4W7X2M5N6P789AB', vertical: 'protocol', before: null, after: { status: 'active' }, causedBy: null, at: ago(2 * 86400e3 + 3 * 60e3) },
];

const svc = 'acme-helpdesk-01j2q8z3v9k4w7x2m5n6p7v300';
/** The older version still serving — so the dev preview of "all versions" merges two. */
const svcPrev = 'acme-helpdesk-01j2q8z3v9k4w7x2m5n6p7v200';
export const MOCK_OBSERVABILITY_LOGS: ObservabilityLogEvent[] = [
  { timestamp: now - 4 * 60e3, level: 'error', message: 'TypeError: cannot read properties of undefined (reading "status") at /operations/close-ticket', service: svc, outcome: 'exception', trigger: 'default.closeTicket', invocation: 'rpc', entrypoint: 'ScopeDO', requestId: 'YAU1U795U1IUWWRM', cpuTimeMs: 3.2, wallTimeMs: 5, raw: { $metadata: { trigger: 'default.closeTicket', level: 'error' }, $workers: { eventType: 'rpc', entrypoint: 'ScopeDO', outcome: 'exception', cpuTimeMs: 3.2 } } },
  { timestamp: now - 11 * 60e3, level: 'log', message: '{"op":"createTicket","durationMs":34}', service: svc, outcome: 'ok', trigger: 'default.createTicket', invocation: 'rpc', entrypoint: 'ScopeDO', requestId: 'ZBV2V806V2JVXXSN', cpuTimeMs: 0.4, wallTimeMs: 34, raw: { $metadata: { trigger: 'default.createTicket', level: 'log' }, $workers: { eventType: 'rpc', entrypoint: 'ScopeDO', outcome: 'ok', cpuTimeMs: 0.4 } } },
  { timestamp: now - 19 * 60e3, level: 'log', message: '{"op":"listTickets","durationMs":11}', service: svcPrev, outcome: 'ok', trigger: 'default.listTickets', invocation: 'rpc', entrypoint: 'ScopeDO', requestId: 'QPD9D3939D9QDDPL', cpuTimeMs: 0.3, wallTimeMs: 11, raw: { $metadata: { trigger: 'default.listTickets', level: 'log' }, $workers: { eventType: 'rpc', entrypoint: 'ScopeDO', outcome: 'ok', cpuTimeMs: 0.3 } } },
  { timestamp: now - 26 * 60e3, level: 'warn', message: 'retrying webhook delivery (attempt 2)', service: svc, outcome: 'ok', trigger: 'POST /internal/webhook', invocation: 'fetch', entrypoint: null, requestId: 'ACW3W917W3KWYYTO', cpuTimeMs: 1.1, wallTimeMs: 12, raw: { $metadata: { trigger: 'POST /internal/webhook', level: 'warn' }, $workers: { eventType: 'fetch', outcome: 'ok', cpuTimeMs: 1.1 } } },
];
