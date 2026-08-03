import { useEffect, useMemo, useState } from 'react';
import type { AdminLogEntry, Tenant, TenantId, TenantRole } from '@substrat-run/contracts';
import { Badge, Button, Card, EmptyState, Select, SubIcon, SubIcons, Table, Tabs, Tag } from '../components';
import type { TableColumn } from '../components';
import { ActorCell } from '../patterns/ActorCell';
import { JsonDiff } from '../patterns/JsonDiff';
import type { Api } from '../lib/api';
import { usePagedList } from '../lib/use-paged-list';

/**
 * The runtime half of the permission checkpoint (control-plane.md §4.5).
 *
 * Roles declared in code are already emitted to `demos/*​/PERMISSIONS.md` and
 * CI-diffed. What only exists at runtime — operator-defined roles and
 * per-principal capability grants — is visible nowhere but here.
 *
 * Two of the three tabs are live:
 *
 * - **Needs review** needs no plumbing at all: a role redefinition or a grant IS
 *   an admin-log row, and `before`/`after` on a `defineRole` row is literally the
 *   permission diff. This is the design's strongest idea.
 * - **Roles** reads `listRoles`. Roles were writable and not enumerable since the
 *   permission model shipped — CI diffs what code DECLARES, and this is the only
 *   way to see what a live deployment HOLDS, which is a different question.
 * - **Capability grants** is still a stated gap, and not because the work was
 *   skipped: it is a genuinely bigger problem than roles were. Roles are
 *   directory-local (`_substrat_roles` sits beside the tenant registry). A grant
 *   is a tuple in the SCOPE's own database, which the control plane must never
 *   reach into (§7) — the only sanctioned path is §5.4's admin-query RPC, which
 *   does not exist. It renders as a gap rather than a mock: a permission surface
 *   showing fabricated grants is worse than one admitting it cannot see them.
 */

/** The three writes that create permission state at runtime. */
const REVIEWABLE = ['defineRole', 'grant', 'grantToOrg'] as const;

/** The review queue's page — kept at the pre-pagination read size. */
const LOG_PAGE = 50;

export interface PermissionsProps {
  api: Api;
  tenants: Map<TenantId, Tenant>;
}

export function Permissions({ api, tenants }: PermissionsProps) {
  const [tab, setTab] = useState('review');
  const [rows, setRows] = useState<AdminLogEntry[]>([]);
  // Null = the log is exhausted (pagination.ts); non-null continues the walk below.
  const [logCursor, setLogCursor] = useState<string | null>(null);
  const [source, setSource] = useState('all');
  const [reviewed, setReviewed] = useState<Record<string, true>>({});

  // The roles table pages like every other list (first page of 20, Load more) —
  // before pagination this was one unbounded read; a silently truncated page
  // with no way to continue would hide roles from the one place that shows them.
  const rolesPage = usePagedList((p) => api.listRoles(p), [api]);
  const roles = rolesPage.entries;

  useEffect(() => {
    let live = true;
    void (async () => {
      const page = await api.adminLog({ order: 'desc', limit: LOG_PAGE, action: [...REVIEWABLE] });
      if (!live) return;
      setRows(page.entries);
      setLogCursor(page.nextCursor);
    })();
    return () => {
      live = false;
    };
  }, [api]);

  // The AdminLog continuation: older reviewable entries append, newest stay put.
  async function loadOlder() {
    if (!logCursor) return;
    const page = await api.adminLog({
      order: 'desc',
      limit: LOG_PAGE,
      cursor: logCursor,
      action: [...REVIEWABLE],
    });
    setRows((prev) => [...prev, ...page.entries]);
    setLogCursor(page.nextCursor);
  }

  const pending = rows.filter((r) => !reviewed[r.id]);
  // Filtered client-side over the LOADED pages (the AdminLog `q` pattern): the
  // role set is small (one row per tenant per role key), so a round-trip per
  // filter change would buy nothing. The API takes `source` for callers that
  // aren't holding the list.
  const sources = useMemo(() => [...new Set(roles.map((r) => r.source))].sort(), [roles]);

  const roleColumns: TableColumn<TenantRole>[] = [
    { header: 'Role', render: (r) => <Tag mono>{r.key}</Tag> },
    { header: 'Tenant', render: (r) => tenants.get(r.tenantId)?.slug ?? r.tenantId, mono: true, muted: true },
    {
      header: 'Permissions',
      render: (r) => (
        <span style={{ display: 'inline-flex', gap: 4, flexWrap: 'wrap' }}>
          {r.permissions.map((p) => (
            <Tag key={p} mono>
              {p}
            </Tag>
          ))}
        </span>
      ),
    },
    { header: 'Count', render: (r) => r.permissions.length, mono: true, align: 'right', width: 70 },
    { header: 'Source', render: (r) => r.source, mono: true, muted: true, align: 'right' },
  ];

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 20 }}>
      <div>
        <h1 style={{ margin: 0, fontSize: 22, lineHeight: '29px', fontWeight: 600, letterSpacing: '-0.02em', color: 'var(--text-primary)' }}>
          Permissions
        </h1>
        <p style={{ margin: '4px 0 0', fontSize: 13, color: 'var(--text-tertiary)', maxWidth: 640 }}>
          Roles declared in code are diffed by CI. What only exists at runtime — operator-defined roles and per-record
          capability grants — is visible nowhere but here.
        </p>
      </div>

      <Tabs
        value={tab}
        onChange={setTab}
        tabs={[
          { value: 'review', label: 'Needs review', count: pending.length },
          // One Roles tab with a source filter, not a structurally separate
          // "operator roles" — a reviewer wants code-declared roles next to the
          // operator-made ones, not a tab that hides them.
          { value: 'roles', label: 'Roles' },
          { value: 'grants', label: 'Capability grants' },
        ]}
      />

      {tab === 'review' && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
          {pending.length === 0 && (
            <Card>
              <EmptyState
                icon={<SubIcon d={SubIcons.cog} size={20} />}
                title="Nothing awaiting review"
                description="Runtime role and grant changes appear here as they happen."
              />
            </Card>
          )}
          {pending.map((r) => (
            <Card
              key={r.id}
              title={r.action === 'defineRole' ? 'Role redefined' : 'Capability grant'}
              description={`${r.tenantId ? (tenants.get(r.tenantId)?.slug ?? r.tenantId) : 'platform'}${r.scopeId ? ` · scope ${r.scopeId.slice(0, 8)}…` : ' (tenant-wide)'} · ${r.at.slice(0, 19).replace('T', ' ')}`}
              actions={
                <span style={{ display: 'inline-flex', alignItems: 'center', gap: 10 }}>
                  <ActorCell actor={r.actor} />
                  <Badge status="info">runtime</Badge>
                </span>
              }
              footer="Approval is console-side review metadata — it does not gate the change, which already applied."
            >
              <JsonDiff before={r.before} after={r.after} />
              <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8, marginTop: 12 }}>
                <Button variant="secondary" size="sm" onClick={() => setReviewed((p) => ({ ...p, [r.id]: true }))}>
                  Flag
                </Button>
                <Button size="sm" onClick={() => setReviewed((p) => ({ ...p, [r.id]: true }))}>
                  Approve
                </Button>
              </div>
            </Card>
          ))}
          {logCursor && (
            <div style={{ display: 'flex', justifyContent: 'center' }}>
              <Button variant="ghost" size="sm" onClick={() => void loadOlder()}>
                Load older entries
              </Button>
            </div>
          )}
        </div>
      )}

      {tab === 'roles' && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
          <div style={{ display: 'flex', gap: 10 }}>
            <Select
              options={[
                { value: 'all', label: 'All sources' },
                ...sources.map((s) => ({ value: s, label: s })),
              ]}
              value={source}
              onChange={(e) => setSource(e.target.value)}
              style={{ width: 260 }}
            />
          </div>
          <Card
            padding={0}
            footer="Every role here is declared in code — an engine's manifest or a vertical's constants. There is no source meaning 'an operator created this against a live deployment': nothing can create one yet, so the value would have no producer. It lands with whatever writes it."
          >
            <Table
              columns={roleColumns}
              rows={roles.filter((r) => source === 'all' || r.source === source)}
              emptyText="No roles defined."
            />
            {rolesPage.nextCursor && (
              <div style={{ padding: 12, display: 'flex', justifyContent: 'center' }}>
                <Button variant="ghost" size="sm" onClick={() => void rolesPage.loadMore()}>
                  Load more
                </Button>
              </div>
            )}
          </Card>
        </div>
      )}

      {tab === 'grants' && (
        <Card footer="Enumeration is per scope by design — and by necessity: grants are tuples in each scope's own database, which the control plane reaches only through the admin-query RPC (§5.4), not by reading scope tables.">
          <EmptyState
            icon={<SubIcon d={SubIcons.cog} size={20} />}
            title="Capability grants cannot be listed yet"
            description="Needs the §5.4 admin-query RPC plus listGrants. Two things to know before this ships: grantedBy is never persisted — the tuple stores only (subject, relation, object, expires_at), so it survives in the admin log alone; and every permission write is one-way today — no revoke, no enumeration — so this view would be the only witness to grants it cannot read."
          />
        </Card>
      )}
    </div>
  );
}
