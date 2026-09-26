import type { AuditEntry, ListPage, PageOpts } from './api';
import { MOCK_OVERVIEW_AUDIT } from './mock-overview';

/**
 * Dev-preview fixtures for the Audit page (#1825): a few days of the team's admin log —
 * people by email, the platform's own services by their fixed actor ids, a handful with
 * a before → after — served in pages so "Load older" and a deep link into an older page
 * can be reviewed without a control plane. The Overview's entries are included, so its
 * Recent activity rows open here in the preview too.
 */
const back = (ms: number) => new Date(Date.now() - ms).toISOString();
const T = '01J2Q8Z3V9K4W7X2M5N6P7TNT0';
const HR = '01J2Q8Z3V9K4W7X2M5N6P789AB';
const LEGAL = '01J2Q8Z3V9K4W7X2M5N6P7LEGA';
const SUPPORT = '01J2Q8Z3V9K4W7X2M5N6P7SUPP';
const FIELD = '01J2Q8Z3V9K4W7X2M5N6P7FIEL';
const DASH = '01JZ000000000000000000DASH';
const SWEEP = '01JZ00000000000000000000SW';
const RELAY = '01JZ00000000000000000000CR';
const H = 3600e3;
const D = 86400e3;

const e = (id: string, actor: string, action: string, scopeId: string | null, vertical: string | null, before: unknown, after: unknown, at: string, causedBy: string | null = null): AuditEntry => ({
  id: `01J2Q8ZAUDITMOCK000000${id}`,
  actor,
  action,
  tenantId: T,
  scopeId,
  vertical,
  before,
  after,
  causedBy,
  at,
});

const MORE: AuditEntry[] = [
  e('0B01', 'dana@acme.com', 'updateConnectionSecret', HR, 'protocol', null, { provider: 'scrive', label: 'Production' }, back(20 * 60e3)),
  e('0B02', DASH, 'bindHostname', SUPPORT, 'ticket0', null, { hostname: 'help.acme.test', surface: 'app' }, back(50 * 60e3)),
  e('0B03', RELAY, 'createConnection', HR, 'protocol', null, { provider: 'scrive', label: 'Production' }, back(2 * H), '01J2Q8Z3EVENT00000000CONN01'),
  e('0B04', SWEEP, 'reapScope', null, null, { status: 'failed' }, { status: 'reaped' }, back(5 * H)),
  e('0B05', 'alex.ek@acme.com', 'defineRole', LEGAL, 'protocol', { permissions: ['case.read'] }, { permissions: ['case.read', 'case.export'] }, back(D + 2 * H)),
  e('0B06', 'dana@acme.com', 'suspendScope', FIELD, 'workorder', { status: 'active' }, { status: 'suspended' }, back(D + 4 * H)),
  e('0B07', SWEEP, 'setHostnameStatus', LEGAL, null, { status: 'pending' }, { status: 'active', hostname: 'acme-legal.substrat.run' }, back(D + 7 * H)),
  e('0B08', 'sam.lind@acme.com', 'assignRole', SUPPORT, 'ticket0', { role: 'agent' }, { role: 'lead' }, back(2 * D + 3 * H)),
  e('0B09', DASH, 'bindScopeVersion', LEGAL, 'protocol', { versionId: '01J2Q8…V030' }, { versionId: '01J2Q8…V040' }, back(2 * D + 5 * H), '01J2Q8Z3EVENT00000000DEPLOY'),
  e('0B10', 'dana@acme.com', 'grantEntitlement', null, null, null, { key: 'observability.retention-90d' }, back(3 * D + H)),
  e('0B11', '01J2Q8Z3V9K4W7X2M5N6P7STF1', 'restoreScope', HR, 'protocol', null, { bookmark: '0000019a-…-7f3c' }, back(3 * D + 6 * H)),
];

/** The team's admin log, newest first — what `GET /api/audit` would page through. */
export const MOCK_AUDIT_LOG: AuditEntry[] = [...MOCK_OVERVIEW_AUDIT, ...MORE].sort((a, b) => b.at.localeCompare(a.at));

const PAGE = 8;

/** `auditLogAll` against the fixture: the same keyset-shaped page, `cursor` is an offset. */
export function mockAuditLogAll(opts?: PageOpts & { scopeId?: string }): Promise<ListPage<AuditEntry>> {
  const all = opts?.scopeId ? MOCK_AUDIT_LOG.filter((x) => x.scopeId === opts.scopeId) : MOCK_AUDIT_LOG;
  const from = opts?.cursor ? Number(opts.cursor) : 0;
  const to = from + PAGE;
  return Promise.resolve({ entries: all.slice(from, to), nextCursor: to < all.length ? String(to) : null });
}
