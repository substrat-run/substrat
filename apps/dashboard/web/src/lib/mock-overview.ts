import type { AccountIntegrationsView, AppHealthRow, AppRow, AuditEntry } from './api';
import { MOCK_FLEET_HEALTH } from './mock';

/**
 * Dev-preview fixtures for the Overview home (#1815). `MOCK_APPS` has no app that is
 * running AND fine — its two running apps are failing and stale — so this adds one, and
 * the preview shows every state the page composes a sentence from: failing, stale, OK,
 * installing and a failed install. Anchored to the clock: the activity card prints
 * "today" times, and a fixed date would render every row as months old.
 */
const back = (ms: number) => new Date(Date.now() - ms).toISOString();

export const MOCK_OVERVIEW_EXTRA_APPS: AppRow[] = [
  { id: '5', app_scope_id: '01J2Q8Z3V9K4W7X2M5N6P7SUPP', vertical_slug: 'ticket0', name: 'Acme Support', status: 'active', hostname: 'acme-support.substrat.run', created_by: 'dana@acme.com', created_at: back(9 * 86400e3) },
];

export const MOCK_OVERVIEW_HEALTH: AppHealthRow[] = [
  ...MOCK_FLEET_HEALTH,
  { scopeId: '01J2Q8Z3V9K4W7X2M5N6P7SUPP', name: 'Acme Support', vertical: 'ticket0', state: 'ok', reason: 'Swept, with nothing failing or overdue.', failures: 0, sweepFailures: 0, stale: 0, lastSweepAt: back(3 * 60e3) },
];

const conn = (over: Partial<AccountIntegrationsView['providers'][number]['connections'][number]>) => ({
  id: '01MOCKOVCONN00000000000000',
  label: 'Production',
  status: 'active' as const,
  externalAccountRef: null,
  expiresAt: null,
  lastOkAt: back(14 * 60e3),
  lastError: null,
  lastErrorAt: null,
  createdAt: back(20 * 86400e3),
  vertical: 'protocol',
  apps: [{ scopeId: '01J2Q8Z3V9K4W7X2M5N6P789AB', name: 'Acme HR' }],
  sweepRuns: [],
  ...over,
});

/** One connection in error on the supplier's side, two working. */
export const MOCK_OVERVIEW_INTEGRATIONS: AccountIntegrationsView = {
  providers: [
    {
      provider: 'scrive',
      name: 'Scrive',
      description: 'E-signing for documents and protocols.',
      monogram: 'Sc',
      fields: [],
      connectFlow: null,
      connections: [conn({ id: '01MOCKOVCONN0000000000SCRV', apps: [{ scopeId: '01J2Q8Z3V9K4W7X2M5N6P789AB', name: 'Acme HR' }, { scopeId: '01J2Q8Z3V9K4W7X2M5N6P7LEGA', name: 'Acme Legal' }] })],
      connectTargets: [],
    },
    {
      provider: 'fortnox',
      name: 'Fortnox',
      description: 'Accounting: invoices and vouchers.',
      monogram: 'Fx',
      fields: [],
      connectFlow: 'redirect',
      connections: [
        conn({
          id: '01MOCKOVCONN0000000000FRTX',
          status: 'error',
          vertical: 'ticket0',
          apps: [{ scopeId: '01J2Q8Z3V9K4W7X2M5N6P7SUPP', name: 'Acme Support' }],
          lastOkAt: back(26 * 3600e3),
          lastError: 'HTTP 503 from Fortnox: service temporarily unavailable',
          lastErrorAt: back(40 * 60e3),
        }),
      ],
      connectTargets: [],
    },
    {
      provider: 'planima',
      name: 'Planima',
      description: 'Staff scheduling.',
      monogram: 'Pl',
      fields: [],
      connectFlow: null,
      connections: [conn({ id: '01MOCKOVCONN0000000000PLNM', vertical: 'ticket0', apps: [{ scopeId: '01J2Q8Z3V9K4W7X2M5N6P7SUPP', name: 'Acme Support' }], lastOkAt: back(2 * 60e3) })],
      connectTargets: [],
    },
  ],
};

const T = '01J2Q8Z3V9K4W7X2M5N6P7TNT0';
export const MOCK_OVERVIEW_AUDIT: AuditEntry[] = [
  { id: '01J2Q8ZOVAUDIT0000000000A6', actor: 'dana@acme.com', action: 'promoteVersion', tenantId: T, scopeId: '01J2Q8Z3V9K4W7X2M5N6P789AB', vertical: 'protocol', before: null, after: { version: '0.4.1' }, causedBy: null, at: back(35 * 60e3) },
  { id: '01J2Q8ZOVAUDIT0000000000A5', actor: 'service:control-plane', action: 'bindScopeVersion', tenantId: T, scopeId: '01J2Q8Z3V9K4W7X2M5N6P789AB', vertical: 'protocol', before: null, after: { versionId: '01J2Q8…V041' }, causedBy: null, at: back(36 * 60e3) },
  { id: '01J2Q8ZOVAUDIT0000000000A4', actor: 'alex.ek@acme.com', action: 'assignRole', tenantId: T, scopeId: '01J2Q8Z3V9K4W7X2M5N6P7SUPP', vertical: 'ticket0', before: null, after: { role: 'editor' }, causedBy: null, at: back(3 * 3600e3) },
  { id: '01J2Q8ZOVAUDIT0000000000A3', actor: 'dana@acme.com', action: 'grantEntitlement', tenantId: T, scopeId: null, vertical: null, before: null, after: { key: 'builder' }, causedBy: null, at: back(26 * 3600e3) },
  { id: '01J2Q8ZOVAUDIT0000000000A2', actor: 'service:control-plane', action: 'provisionScope', tenantId: T, scopeId: '01J2Q8Z3V9K4W7X2M5N6P7FIEL', vertical: 'workorder', before: null, after: { status: 'provisioning' }, causedBy: null, at: back(2 * 86400e3) },
  { id: '01J2Q8ZOVAUDIT0000000000A1', actor: 'alex.ek@acme.com', action: 'revokeInvite', tenantId: T, scopeId: null, vertical: null, before: null, after: null, causedBy: null, at: back(4 * 86400e3) },
];
