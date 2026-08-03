import { Fragment, useEffect, useState } from 'react';
import { adminAction } from '@substrat-run/contracts';
import type { AdminAction, AdminLogEntry, Tenant, TenantId } from '@substrat-run/contracts';
import { Button, Card, Input, Select, Tag } from '../components';
import { ActorCell } from '../patterns/ActorCell';
import { JsonDiff } from '../patterns/JsonDiff';
import type { Api } from '../lib/api';

const ALL_ACTIONS = adminAction.options;
// The platform-wide default page (contracts LIST_PAGE_DEFAULT) — this view grew
// the convention, and now matches it.
const PAGE = 20;

export interface AdminLogProps {
  api: Api;
  tenants: Map<TenantId, Tenant>;
}

export function AdminLog({ api, tenants }: AdminLogProps) {
  const [entries, setEntries] = useState<AdminLogEntry[]>([]);
  // Null IS exhausted now (pagination.ts): a short page answers `nextCursor: null`,
  // so the old separate short-page detection is gone.
  const [cursor, setCursor] = useState<string | null>(null);
  const [expanded, setExpanded] = useState<string>();
  const [action, setAction] = useState('all');
  const [tenantFilter, setTenantFilter] = useState('all');
  const [q, setQ] = useState('');

  // Server-side narrowing for what the API can filter; `q` stays client-side
  // over the loaded page — the log has no substring index, and pretending
  // otherwise would silently search only what happens to be loaded anyway.
  useEffect(() => {
    let live = true;
    void (async () => {
      const page = await api.adminLog({
        order: 'desc',
        limit: PAGE,
        action: action === 'all' ? undefined : [action as AdminAction],
        tenantId: tenantFilter === 'all' ? undefined : (tenantFilter as TenantId),
      });
      if (!live) return;
      setEntries(page.entries);
      setCursor(page.nextCursor);
    })();
    return () => {
      live = false;
    };
  }, [api, action, tenantFilter]);

  async function loadOlder() {
    if (!cursor) return;
    const page = await api.adminLog({
      order: 'desc',
      limit: PAGE,
      cursor,
      action: action === 'all' ? undefined : [action as AdminAction],
      tenantId: tenantFilter === 'all' ? undefined : (tenantFilter as TenantId),
    });
    setEntries((prev) => [...prev, ...page.entries]);
    setCursor(page.nextCursor);
  }

  const visible = entries.filter((e) => {
    if (!q) return true;
    const hay = `${e.actor}${e.action}${e.tenantId ?? 'platform'}${e.scopeId ?? ''}`.toLowerCase();
    return hay.includes(q.toLowerCase());
  });

  const th: React.CSSProperties = {
    textAlign: 'left',
    padding: '0 16px',
    height: 36,
    fontSize: 11,
    fontWeight: 500,
    letterSpacing: '0.06em',
    textTransform: 'uppercase',
    color: 'var(--text-tertiary)',
    borderBottom: '1px solid var(--border-default)',
    background: 'var(--surface-inset)',
    whiteSpace: 'nowrap',
  };
  const td: React.CSSProperties = {
    padding: '0 16px',
    height: 40,
    borderBottom: '1px solid var(--border-subtle)',
    fontSize: 12.5,
  };

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 20 }}>
      <div>
        <h1 style={{ margin: 0, fontSize: 22, lineHeight: '29px', fontWeight: 600, letterSpacing: '-0.02em', color: 'var(--text-primary)' }}>
          Admin log
        </h1>
        <p style={{ margin: '4px 0 0', fontSize: 13, color: 'var(--text-tertiary)', maxWidth: 640 }}>
          Every privileged action against the control plane — append-only, stamped platform-side, newest first. Row click
          shows what changed.
        </p>
      </div>

      <div style={{ display: 'flex', gap: 10 }}>
        <Input placeholder="Filter by actor, tenant, or scope…" value={q} onChange={(e) => setQ(e.target.value)} style={{ width: 300 }} />
        <Select
          options={[{ value: 'all', label: 'All actions' }, ...ALL_ACTIONS.map((a) => ({ value: a, label: a }))]}
          value={action}
          onChange={(e) => setAction(e.target.value)}
          style={{ width: 190 }}
        />
        <Select
          options={[
            { value: 'all', label: 'All tenants' },
            ...[...tenants.values()].map((t) => ({ value: t.id, label: t.slug })),
          ]}
          value={tenantFilter}
          onChange={(e) => setTenantFilter(e.target.value)}
          style={{ width: 160 }}
        />
      </div>

      <Card
        padding={0}
        footer="Actors are PlatformActorIds — labels are console-side aliases, not platform identity. Cursor-paginated."
      >
        <table style={{ width: '100%', borderCollapse: 'collapse', fontFamily: 'var(--font-sans)', fontSize: 14 }}>
          <thead>
            <tr>
              {['Time', 'Actor', 'Action', 'Tenant', 'Scope', 'Vertical'].map((h) => (
                <th key={h} style={th}>
                  {h}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {visible.map((e) => (
              <Fragment key={e.id}>
                <tr
                  onClick={() => setExpanded(expanded === e.id ? undefined : e.id)}
                  style={{ cursor: 'pointer', background: expanded === e.id ? 'var(--surface-hover)' : 'transparent' }}
                >
                  <td style={{ ...td, fontFamily: 'var(--font-mono)', color: 'var(--text-tertiary)', whiteSpace: 'nowrap' }}>
                    {e.at.slice(0, 19).replace('T', ' ')}
                  </td>
                  <td style={td}>
                    <ActorCell actor={e.actor} />
                  </td>
                  <td style={{ ...td, fontFamily: 'var(--font-mono)', color: 'var(--text-primary)' }}>{e.action}</td>
                  <td style={{ ...td, fontFamily: 'var(--font-mono)', color: 'var(--text-tertiary)' }}>
                    {/* A null tenant is not missing data — it is a platform-level
                        action that targets no tenant (K-23), like registering a
                        central identity pool. */}
                    {e.tenantId ? (
                      (tenants.get(e.tenantId)?.slug ?? e.tenantId.slice(0, 8))
                    ) : (
                      <span style={{ color: 'var(--text-placeholder)' }}>platform</span>
                    )}
                  </td>
                  <td style={{ ...td, fontFamily: 'var(--font-mono)', color: 'var(--text-tertiary)' }}>
                    {/* A null scopeId is not missing data — it is a tenant-wide action. */}
                    {e.scopeId ? e.scopeId.slice(0, 8) + '…' : <span style={{ color: 'var(--text-placeholder)' }}>tenant-wide</span>}
                  </td>
                  <td style={td}>{e.vertical ? <Tag mono>{e.vertical}</Tag> : <span style={{ color: 'var(--text-placeholder)' }}>—</span>}</td>
                </tr>
                {expanded === e.id && (
                  <tr>
                    <td colSpan={6} style={{ padding: 12, background: 'var(--surface-hover)', borderBottom: '1px solid var(--border-subtle)' }}>
                      <JsonDiff before={e.before} after={e.after} />
                    </td>
                  </tr>
                )}
              </Fragment>
            ))}
            {visible.length === 0 && (
              <tr>
                <td colSpan={6} style={{ ...td, color: 'var(--text-placeholder)', textAlign: 'center', height: 80 }}>
                  No entries match.
                </td>
              </tr>
            )}
          </tbody>
        </table>
        {cursor && (
          <div style={{ padding: 12, display: 'flex', justifyContent: 'center' }}>
            <Button variant="ghost" size="sm" onClick={() => void loadOlder()}>
              Load older entries
            </Button>
          </div>
        )}
      </Card>
    </div>
  );
}
