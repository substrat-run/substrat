/**
 * Demo data for the screens the platform does not back yet (docs/design/dashboard.md
 * §6: M1 team, M2 ops, M3 plan, plus the design-ahead future screens). The M0 flow
 * — sign-in, the app list, create-app, the app header — runs on the real worker
 * API (lib/api.ts); everything here is clearly-labelled placeholder data shown
 * behind the design's honesty banners, never presented as live.
 *
 * The generic "Acme" tenant from the design handoff.
 */
import type { IconName } from './icons';
import type {
  AppEnvView,
  AppIntegrationsView,
  AccountIntegrationsView,
  AppScope,
  ConnectionActivityView,
  ConnectionProbeView,
} from './api';

/** Per-vertical display metadata — the "kind" label and its layer-accent colour. */
export interface VerticalMeta {
  label: string;
  accent: string;
}

const LAYER = {
  vertical: 'var(--layer-vertical)', // amber — Documents
  engine: 'var(--layer-engine)', // cyan — Work Orders
  kernel: 'var(--layer-kernel)', // indigo — Invoicing
} as const;

const VERTICAL_META: Record<string, VerticalMeta> = {
  protocol: { label: 'Documents', accent: LAYER.vertical },
  documents: { label: 'Documents', accent: LAYER.vertical },
  dashboard: { label: 'Dashboard', accent: LAYER.kernel },
  workorder: { label: 'Work Orders', accent: LAYER.engine },
  callout: { label: 'Callout', accent: LAYER.engine },
  // Meridian's core (leave, time, expenses) is vertical code on the kernel with no
  // engine behind it — the kernel accent marks that "the kernel carries the domain".
  meridian: { label: 'Meridian', accent: LAYER.kernel },
  invoicing: { label: 'Invoicing', accent: LAYER.kernel },
};

/** Look up a vertical's label + accent, falling back to a title-cased slug. */
export function verticalMeta(slug: string): VerticalMeta {
  return (
    VERTICAL_META[slug] ?? {
      label: slug.charAt(0).toUpperCase() + slug.slice(1),
      accent: LAYER.kernel,
    }
  );
}

// -- M1: team ---------------------------------------------------------------

export type MemberStatus = 'active' | 'invited' | 'revoked';
export interface Member {
  name: string;
  email: string;
  role: 'owner' | 'admin' | 'member' | 'viewer';
  status: MemberStatus;
  added: string;
  avatar: 'brand' | 'cyan' | 'amber' | 'muted';
  you?: boolean;
}

export const MEMBERS: Member[] = [
  { name: 'Dana Vogel', email: 'dana@acme.com', role: 'owner', status: 'active', added: 'Mar 2, 2026', avatar: 'brand', you: true },
  { name: 'Jonas Berg', email: 'jonas@acme.com', role: 'admin', status: 'active', added: 'Apr 11, 2026', avatar: 'cyan' },
  { name: 'Priya Shah', email: 'priya@acme.com', role: 'member', status: 'invited', added: 'Jul 20, 2026', avatar: 'amber' },
  { name: 'Leo Martin', email: 'leo@acme.com', role: 'viewer', status: 'revoked', added: 'May 5, 2026', avatar: 'muted' },
];

export interface RolePerm {
  label: string;
  owner: boolean;
  admin: boolean;
  member: boolean;
  viewer: boolean;
}
export const ROLE_MATRIX: RolePerm[] = [
  { label: 'Create & manage apps', owner: true, admin: true, member: false, viewer: false },
  { label: 'Manage domains, env vars & integrations', owner: true, admin: true, member: false, viewer: false },
  { label: 'Invite & manage members', owner: true, admin: true, member: false, viewer: false },
  { label: 'Use apps & edit content', owner: true, admin: true, member: true, viewer: false },
  { label: 'View apps, analytics & billing', owner: true, admin: true, member: true, viewer: true },
];

// -- M2: domains ------------------------------------------------------------

export type DomainStatus = 'active' | 'pending' | 'failed';
export interface DomainRow {
  hostname: string;
  app: string;
  status: DomainStatus;
  added: string;
  primary?: boolean;
  /** Present on failed rows — the wrong-CNAME explainer. */
  problem?: { current: string; expected: string };
}
export const DOMAINS: DomainRow[] = [
  { hostname: 'hr.acme.com', app: 'Acme HR', status: 'active', added: 'Jul 21, 2026', primary: true },
  { hostname: 'legal.acme.com', app: 'Acme Legal', status: 'pending', added: 'today' },
  {
    hostname: 'app.acme.io',
    app: 'Acme Field Ops',
    status: 'failed',
    added: 'Jul 18, 2026',
    problem: { current: 'old-host.example.com', expected: 'edge.substrat.run' },
  },
];

// -- M2: env vars -----------------------------------------------------------

export interface EnvVar {
  key: string;
  /** The masked-or-revealed display value; `revealed` marks an audited reveal. */
  value: string;
  environment: 'Production' | 'Preview' | 'All';
  revealed?: boolean;
}
export const ENV_VARS: EnvVar[] = [
  { key: 'SCRIVE_API_TOKEN', value: '••••••••••••••••', environment: 'Production' },
  { key: 'FORTNOX_CLIENT_SECRET', value: 'fnx_5c81…e2a9', environment: 'All', revealed: true },
  { key: 'SMTP_PASSWORD', value: '••••••••••••', environment: 'Production' },
  { key: 'POSTMARK_SERVER_TOKEN', value: '••••••••••••••••••', environment: 'Preview' },
];

/** Dev-preview sample for the Env tab — an env-spec + values so the form isn't empty
 *  without a backend (VITE_DEV_MOCK). Mirrors the real `GET /api/apps/:scope/env` shape. */
export const MOCK_APP_ENV: AppEnvView = {
  spec: [
    { key: 'PUBLIC_ORIGIN', label: 'Public origin', description: 'The public URL this app is served at.', placeholder: 'https://app.acme.com', required: true, secret: false, group: 'General' },
    { key: 'SMTP_PASSWORD', label: 'SMTP password', description: 'Credential for outbound email.', placeholder: 'at least 8 characters', required: false, secret: true, group: 'Email' },
    { key: 'EMAIL_FROM', label: 'Sender address', description: 'The From address for transactional mail.', placeholder: 'no-reply@acme.com', required: false, secret: false, group: 'Email' },
  ],
  values: [
    { key: 'PUBLIC_ORIGIN', isSecret: false, hasValue: true, value: 'https://hr.acme.com', updatedAt: '' },
    { key: 'SMTP_PASSWORD', isSecret: true, hasValue: true, value: null, updatedAt: '' },
  ],
};

// -- M2: integrations -------------------------------------------------------

/** Dev-preview fixtures (VITE_DEV_MOCK) mirroring the real integrations routes. */
const SCRIVE_FIELDS = [
  { key: 'clientId', label: 'Client credentials identifier', secret: false },
  { key: 'clientSecret', label: 'Client credentials secret', secret: true },
  { key: 'tokenId', label: 'Token credentials identifier', secret: false },
  { key: 'tokenSecret', label: 'Token credentials secret', secret: true },
];

export const MOCK_APP_INTEGRATIONS: AppIntegrationsView = {
  providers: [
    {
      provider: 'scrive',
      name: 'Scrive',
      description: 'E-signing for documents and protocols.',
      monogram: 'Sc',
      fields: SCRIVE_FIELDS,
      required: true,
      connection: null,
    },
  ],
};

export const MOCK_ACCOUNT_INTEGRATIONS: AccountIntegrationsView = {
  providers: [
    {
      provider: 'scrive',
      name: 'Scrive',
      description: 'E-signing for documents and protocols.',
      monogram: 'Sc',
      fields: SCRIVE_FIELDS,
      connections: [
        {
          id: '01MOCKCONNECTION0000000000',
          label: 'Scrive (testbed)',
          status: 'active',
          externalAccountRef: null,
          expiresAt: null,
          lastOkAt: new Date(Date.now() - 3600_000).toISOString(),
          lastError: null,
          lastErrorAt: null,
          createdAt: new Date(Date.now() - 86400_000).toISOString(),
          vertical: 'callout',
          apps: [{ scopeId: 'mock-scope-1', name: 'Acme HR' }],
        },
      ],
      connectTargets: [
        { scopeId: 'mock-scope-1', name: 'Acme HR', vertical: 'callout', connected: true },
        { scopeId: 'mock-scope-2', name: 'Acme Legal', vertical: 'meridian', connected: false },
      ],
    },
  ],
};

/** The probe (#605), as the dev preview renders it — a credential the provider accepted. */
export const MOCK_CONNECTION_PROBE: ConnectionProbeView = {
  ok: true,
  accountRef: '30338661',
  accountLabel: 'Acme AB (drift@acme.se)',
  facts: [
    { label: 'Environment', value: 'production (scrive.com)' },
    { label: 'Company', value: 'Acme AB' },
    { label: 'API user', value: 'Alex Ek <drift@acme.se>' },
    { label: 'Role', value: 'account owner' },
  ],
  error: null,
};

/**
 * The dispatch ledger as the detail view shows it — `live: false`, because the fixture
 * is the platform's own record, which is exactly the distinction the real view keeps.
 */
export const MOCK_CONNECTION_ACTIVITY: ConnectionActivityView = {
  source: 'ledger',
  live: false,
  grants: ['protocol:record-signature', 'protocol:attach'],
  credential: [
    { key: 'clientId', label: 'Client credentials identifier', value: '3d4e9f21c0a84b17', masked: false },
    { key: 'clientSecret', label: 'Client credentials secret', value: '••••••••a91f', masked: true },
    { key: 'tokenId', label: 'Token credentials identifier', value: '8b2c17de40915a63', masked: false },
    { key: 'tokenSecret', label: 'Token credentials secret', value: '••••••••7c04', masked: true },
  ],
  entries: [
    {
      key: 'scrive:dispatch:01MOCKINSTANCE000000000001',
      title: 'Serviceavtal v3',
      reference: '8222115557388321607',
      status: 'partly signed (1/2)',
      at: new Date(Date.now() - 7200_000).toISOString(),
      facts: [
        { label: 'Acme AB', value: 'signature recorded' },
        { label: 'Nordljus Fastigheter', value: 'awaiting signature' },
        { label: 'Content hash', value: 'b2f1c0…9ad4' },
      ],
    },
    {
      key: 'scrive:dispatch:01MOCKINSTANCE000000000002',
      title: 'Uppsägning v1',
      reference: '8222115557388321444',
      status: 'signed — sealed copy stored',
      at: new Date(Date.now() - 86400_000 * 3).toISOString(),
      facts: [
        { label: 'Acme AB', value: 'signature recorded' },
        { label: 'Sealed copy', value: 'stored on the instance' },
      ],
    },
  ],
};

/**
 * The provider's own archive — the other question the detail view can ask. Note the
 * third row: a document nobody here created, which is exactly what the ledger cannot
 * show and why the two views are separate rather than one with a filter.
 */
export const MOCK_PROVIDER_DOCUMENTS: ConnectionActivityView = {
  source: 'provider',
  live: true,
  grants: MOCK_CONNECTION_ACTIVITY.grants,
  credential: MOCK_CONNECTION_ACTIVITY.credential,
  entries: [
    {
      key: 'scrive:document:8222115557388321607',
      title: 'Serviceavtal v3',
      reference: '8222115557388321607',
      status: 'awaiting signatures',
      at: new Date(Date.now() - 7200_000).toISOString(),
      facts: [{ label: 'Sent from', value: 'this app' }],
    },
    {
      key: 'scrive:document:8222115557388321444',
      title: 'Uppsägning v1',
      reference: '8222115557388321444',
      status: 'signed',
      at: new Date(Date.now() - 86400_000 * 3).toISOString(),
      facts: [{ label: 'Sent from', value: 'this app' }],
    },
    {
      key: 'scrive:document:8222115557388320001',
      title: 'Hyresavtal (skickat från Scrive)',
      reference: '8222115557388320001',
      status: 'signed',
      at: new Date(Date.now() - 86400_000 * 12).toISOString(),
      facts: [{ label: 'Sent from', value: 'elsewhere in this Scrive account' }],
    },
  ],
};

// -- M3: plan ---------------------------------------------------------------

export interface EntitlementRow {
  label: string;
  accent?: string;
  included: boolean;
  used: string;
  upgrade?: boolean;
}
export const ENTITLEMENTS: EntitlementRow[] = [
  { label: 'Documents engine', accent: LAYER.vertical, included: true, used: '2 apps' },
  { label: 'Work Orders engine', accent: LAYER.engine, included: true, used: '1 app' },
  { label: 'Invoicing engine', accent: LAYER.kernel, included: false, used: '—', upgrade: true },
  { label: 'Apps', included: true, used: '4 / 5' },
  { label: 'Members', included: true, used: '4 / 10' },
  { label: 'Custom domains', included: true, used: '3 / 10' },
];

// -- future: deployments ----------------------------------------------------

export interface Deployment {
  version: string;
  source: string;
  status: 'current' | 'previous';
  promoted: string;
  by: string;
}
export const DEPLOYMENTS: Deployment[] = [
  { version: 'v0.0.2', source: 'hr-portal@e4f21c9', status: 'current', promoted: 'Jul 20, 2026 14:02', by: 'dana@acme.com' },
  { version: 'v0.0.1', source: 'hr-portal@b91d044', status: 'previous', promoted: 'Jul 14, 2026 09:40', by: 'dana@acme.com' },
];

// -- future: analytics ------------------------------------------------------

export interface Kpi {
  label: string;
  value: string;
  delta: string;
  up: boolean;
}
export const KPIS: Kpi[] = [
  { label: 'Requests', value: '1.24M', delta: '▲ 12.4% vs prior 7d', up: true },
  { label: 'Active users', value: '3,482', delta: '▲ 5.1% vs prior 7d', up: true },
  { label: 'Operations / day', value: '86.2k', delta: '▲ 8.9% vs prior 7d', up: true },
  { label: 'Error rate', value: '0.42%', delta: '▼ 0.1pt vs prior 7d', up: true },
];
export const BARS: Array<{ hr: number; ops: number; legal: number }> = [
  { hr: 46, ops: 22, legal: 14 }, { hr: 52, ops: 24, legal: 15 }, { hr: 44, ops: 28, legal: 12 },
  { hr: 58, ops: 30, legal: 18 }, { hr: 62, ops: 26, legal: 16 }, { hr: 40, ops: 18, legal: 10 },
  { hr: 36, ops: 16, legal: 9 }, { hr: 55, ops: 32, legal: 17 }, { hr: 60, ops: 35, legal: 19 },
  { hr: 66, ops: 30, legal: 21 }, { hr: 58, ops: 36, legal: 18 }, { hr: 72, ops: 38, legal: 22 },
  { hr: 50, ops: 24, legal: 13 }, { hr: 68, ops: 40, legal: 24 },
];
export interface AnalyticsRow {
  app: string;
  accent: string;
  requests: string;
  users: string;
  errorRate: string;
  up: boolean;
}
export const ANALYTICS_ROWS: AnalyticsRow[] = [
  { app: 'Acme HR', accent: LAYER.vertical, requests: '712,400', users: '1,904', errorRate: '0.31%', up: true },
  { app: 'Acme Field Ops', accent: LAYER.engine, requests: '385,900', users: '1,120', errorRate: '0.66%', up: true },
  { app: 'Acme Legal', accent: LAYER.kernel, requests: '141,700', users: '458', errorRate: '0.28%', up: false },
];

// -- future: billing --------------------------------------------------------

export interface Invoice {
  id: string;
  amount: string;
  status: 'Paid';
  date: string;
}
export const INVOICES: Invoice[] = [
  { id: 'INV-2026-0007', amount: '€480.00', status: 'Paid', date: 'Jul 1, 2026' },
  { id: 'INV-2026-0006', amount: '€400.00', status: 'Paid', date: 'Jun 1, 2026' },
];

// -- polish: notifications --------------------------------------------------

export interface Notification {
  dot: 'success' | 'warning' | 'neutral';
  body: string;
  time: string;
  unread?: boolean;
}
export const NOTIFICATIONS: Notification[] = [
  { dot: 'success', body: '**Acme Field Ops** is ready — `acme-field-ops.substrat.run` is live.', time: '2m ago', unread: true },
  { dot: 'warning', body: '`legal.acme.com` isn’t verified yet — the CNAME hasn’t propagated.', time: '1h ago' },
  { dot: 'neutral', body: '`priya@acme.com` accepted your invite.', time: 'yesterday' },
];

// -- create-app: sources ----------------------------------------------------

export interface RepoRow {
  name: string;
  meta: string;
  accent: string;
  /** The catalog slug this source maps onto (resolved against the live catalog). */
  slug: string;
}
export const REPOS: RepoRow[] = [
  { name: 'acme-inc/hr-portal', meta: 'Documents engine · updated 3d ago', accent: LAYER.vertical, slug: 'protocol' },
  { name: 'acme-inc/legal-docs', meta: 'Documents engine · updated 1w ago', accent: LAYER.vertical, slug: 'protocol' },
  { name: 'acme-inc/field-ops', meta: 'Work Orders engine · updated 2w ago', accent: LAYER.engine, slug: 'callout' },
];
// The marketplace column of Create App is now live — it renders the real catalog
// (GET /api/catalog) rather than fixtures. See views/CreateApp.tsx.

// -- select option lists (mirror the gallery) -------------------------------

export const STATUS_FILTER = ['All statuses', 'Active', 'Provisioning', 'Failed'];
export const ENV_OPTS = ['Production', 'Preview', 'All'];
export const ROLE_OPTS = ['Owner', 'Admin', 'Member', 'Viewer'];
export const RANGE_OPTS = ['Last 7 days', 'Last 24 hours', 'Last 30 days', 'Custom'];
export const APP_FILTER = ['All apps', 'Acme HR', 'Acme Legal', 'Acme Field Ops'];

/** The per-app detail tabs. Environment / Domains / Integrations live as sections
 *  inside Settings; old tab URLs are aliased in AppDetail. */
export const APP_TABS: Array<{ value: string; label: string; count?: number; future?: boolean }> = [
  { value: 'overview', label: 'Overview' },
  { value: 'data', label: 'Data' },
  { value: 'deployments', label: 'Deployments', future: true },
  { value: 'observability', label: 'Observability' },
  { value: 'permissions', label: 'Permissions' },
  { value: 'audit', label: 'Audit' },
  { value: 'previews', label: 'Previews' },
  { value: 'settings', label: 'Settings' },
];

/** Dev-preview sample for the Data tab (no backend): a couple of tables of an app's DB. */
// A multi-scope app in the preview, so the Data-tab scope switcher renders (both scopes show the
// same mock tables — the preview has no live database).
export const MOCK_APP_SCOPES: AppScope[] = [
  { scopeId: '01JZ0MERIDIANAPPSCOPE0001', name: 'Meridian', status: 'active', isDefault: true },
  { scopeId: '01JZ0MERIDIANSITE00000002', name: 'Second site', status: 'active', isDefault: false },
];

export const MOCK_SCOPE_TABLES: Array<{ name: string; rowCount: number; system: boolean }> = [
  { name: 'meridian_account', rowCount: 3, system: false },
  { name: 'meridian_session', rowCount: 7, system: false },
  { name: '_substrat_outbox', rowCount: 42, system: true },
  { name: '_substrat_tuples', rowCount: 18, system: true },
  { name: '_substrat_migrations', rowCount: 4, system: true },
];

export const MOCK_SCOPE_TABLE_PAGES: Record<
  string,
  { columns: string[]; rows: unknown[][] }
> = {
  meridian_account: {
    columns: ['id', 'email', 'display_name', 'created_at'],
    rows: [
      ['01JZ…A1', 'ada@meridian.test', 'Ada Lovelace', '2026-07-01T09:12:00Z'],
      ['01JZ…B2', 'grace@meridian.test', 'Grace Hopper', '2026-07-02T14:03:00Z'],
      ['01JZ…C3', 'alan@meridian.test', 'Alan Turing', '2026-07-03T08:41:00Z'],
    ],
  },
};

export interface PaletteAction {
  label: string;
  icon: IconName;
}
export const PALETTE_ACTIONS: PaletteAction[] = [
  { label: 'Create app', icon: 'plus' },
  { label: 'Invite member', icon: 'users' },
  { label: 'Add domain', icon: 'globe' },
];
