import { useEffect, useState } from 'react';
import { Badge, Button, Select, Table, type TableColumn } from '@substrat-run/ui';
import { api, ApiError, type AppRow, type AuditEntry } from '../lib/api';
import { DEV_MOCK, MOCK_AUDIT_ENTRIES } from '../lib/mock';
import { relativeTime, shortDate, shortId } from '../lib/format';
import { Page } from '../components/layout';
import { card, Eyebrow } from '../components/ui';

/** Which admin actions read as a status colour in the Audit table. Most are neutral
 *  record-keeping; destructive/terminal ones warn, provisioning/grants affirm. */
function auditStatus(action: string): 'success' | 'danger' | 'warning' | 'neutral' {
  if (/^(delete|reap|reject|unbind|revoke|remove|unassign|suspend|archive)/i.test(action)) return 'danger';
  if (/^(provision|activate|admit|grant|create|bind|promote|assign|restore|import|unsuspend|unarchive)/i.test(action)) return 'success';
  if (/^(set|rewind|publish|request)/i.test(action)) return 'warning';
  return 'neutral';
}

/** A compact one-line summary of what an entry changed, from its applied payload. */
function auditSummary(entry: AuditEntry): string {
  const after = entry.after;
  if (after && typeof after === 'object') {
    const s = Object.entries(after as Record<string, unknown>)
      .map(([k, v]) => `${k}: ${typeof v === 'object' ? JSON.stringify(v) : String(v)}`)
      .join(' · ');
    return s.length > 80 ? `${s.slice(0, 79)}…` : s || '—';
  }
  return entry.vertical ?? '—';
}

/**
 * The Audit page (#479, moved to team level by #1447): Substrat's control-plane admin
 * log — every privileged action against this team's apps, append-only, newest first. A
 * pure READ of the audit spine the platform already writes (control-plane.md §4.4);
 * nothing here mutates. `cursor` walks older entries; a row opens its full before/after.
 *
 * It is a TEAM page with an app filter rather than a tab on each app, because the log is
 * written at the tenant grain and some entries — role changes, entitlements — name no
 * scope at all — a per-app tab could never show those. The app page links in here already
 * narrowed, which is the entrance an app owner actually wanted.
 *
 * The control plane serves this, so embedded mode has nothing to show and the page says so.
 */
export function AuditLog({ apps, scopeId, onScope }: { apps: AppRow[]; scopeId: string | null; onScope: (s: string | null) => void }) {
  const [entries, setEntries] = useState<AuditEntry[] | null>(null);
  const [cursor, setCursor] = useState<string | null>(null);
  const [loadingOlder, setLoadingOlder] = useState(false);
  const [unavailable, setUnavailable] = useState(false);
  const [selected, setSelected] = useState<AuditEntry | null>(null);

  useEffect(() => {
    if (DEV_MOCK) {
      setEntries(scopeId ? MOCK_AUDIT_ENTRIES.filter((e) => e.scopeId === scopeId) : MOCK_AUDIT_ENTRIES);
      return;
    }
    let live = true;
    // Cleared before the refetch: a list of one app's entries under a heading that now
    // names another is worse than a blank moment, and the filter is the whole page here.
    setEntries(null);
    setCursor(null);
    api
      .auditLogAll(scopeId ? { scopeId } : undefined)
      .then((p) => {
        if (!live) return;
        setEntries(p.entries);
        setCursor(p.nextCursor);
      })
      .catch((e) => {
        if (!live) return;
        if (e instanceof ApiError && e.status === 501) setUnavailable(true);
        setEntries([]);
      });
    return () => {
      live = false;
    };
  }, [scopeId]);

  const loadOlder = async () => {
    if (DEV_MOCK || loadingOlder || !cursor) return;
    setLoadingOlder(true);
    try {
      const p = await api.auditLogAll({ ...(scopeId ? { scopeId } : {}), cursor });
      setEntries((prev) => [...(prev ?? []), ...p.entries.filter((e) => !prev?.some((x) => x.id === e.id))]);
      setCursor(p.nextCursor);
    } finally {
      setLoadingOlder(false);
    }
  };

  const appName = (id: string | null): string => {
    // A tenant-level action (a role change, an entitlement) names no scope — an em dash
    // is the honest cell, not a guessed app.
    if (!id) return '—';
    return apps.find((a) => a.app_scope_id === id)?.name ?? shortId(id);
  };

  const columns: TableColumn<AuditEntry>[] = [
    { header: 'When', width: 130, render: (e) => <span title={e.at}>{relativeTime(e.at)}</span> },
    { header: 'Action', width: 210, render: (e) => <Badge status={auditStatus(e.action)} dot={false}>{e.action}</Badge> },
    // The App column only earns its width when the page is showing more than one app.
    ...(scopeId === null
      ? [{ header: 'App', width: 160, muted: true, render: (e: AuditEntry) => appName(e.scopeId) } as TableColumn<AuditEntry>]
      : []),
    { header: 'Actor', mono: true, muted: true, render: (e) => <span title={e.actor}>{e.actor}</span> },
    { header: 'Change', muted: true, render: (e) => auditSummary(e) },
  ];

  return (
    <Page>
      <div style={{ display: 'flex', alignItems: 'flex-start', gap: 12 }}>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
          <span style={{ fontSize: 22, fontWeight: 600, letterSpacing: '-0.02em', color: 'var(--text-primary)' }}>Audit</span>
          <div style={{ fontSize: 13, color: 'var(--text-secondary)' }}>Every control-plane action on this team&rsquo;s apps, newest first.</div>
        </div>
        <div style={{ flex: 1 }} />
        <Select
          options={[{ value: '', label: 'All apps' }, ...apps.map((a) => ({ value: a.app_scope_id, label: a.name }))]}
          value={scopeId ?? ''}
          onChange={(e) => onScope(e.target.value || null)}
          style={{ width: 200 }}
        />
      </div>

      <div style={{ ...card, padding: 0, overflow: 'hidden' }}>
        <div style={{ padding: '16px 20px', borderBottom: '1px solid var(--border-subtle)' }}>
          <Eyebrow>Audit log</Eyebrow>
          <div style={{ fontSize: 12.5, color: 'var(--text-tertiary)', paddingTop: 4 }}>
            Every privileged action against this team&rsquo;s scopes, newest first — the append-only record
            Substrat keeps of who changed what. Read-only.
          </div>
        </div>
        {entries === null ? (
          <div style={{ padding: 20, fontSize: 12.5, color: 'var(--text-tertiary)' }}>Loading audit log…</div>
        ) : unavailable ? (
          <div style={{ padding: 20, fontSize: 12.5, color: 'var(--text-tertiary)' }}>
            The audit log is served by the control plane, which isn&rsquo;t available in this environment.
          </div>
        ) : (
          <>
            <Table columns={columns} rows={entries} onRowClick={(e) => setSelected(e)} emptyText="No audited actions yet." />
            {cursor !== null && (
              <div style={{ display: 'flex', justifyContent: 'center', padding: 12 }}>
                <Button variant="secondary" onClick={() => void loadOlder()} disabled={loadingOlder}>
                  {loadingOlder ? 'Loading…' : 'Load older entries'}
                </Button>
              </div>
            )}
          </>
        )}
        {selected && <AuditDetail entry={selected} onClose={() => setSelected(null)} />}
      </div>
    </Page>
  );
}

/** Read-only detail for one audit entry — the shared Dialog is confirm-shaped, so this
 *  is a plain overlay with a single Close. Shows before/after and the causing event. */
function AuditDetail({ entry, onClose }: { entry: AuditEntry; onClose: () => void }) {
  const mono = { fontFamily: 'var(--font-mono)' } as const;
  const field = (label: string, node: React.ReactNode) => (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
      <span style={{ fontSize: 11, textTransform: 'uppercase', letterSpacing: 'var(--tracking-caps)', color: 'var(--text-tertiary)' }}>{label}</span>
      <div style={{ color: 'var(--text-primary)', fontSize: 13 }}>{node}</div>
    </div>
  );
  const json = (value: unknown) => (
    <pre style={{ margin: 0, padding: 10, background: 'var(--surface-inset)', border: '1px solid var(--border-subtle)', borderRadius: 6, ...mono, fontSize: 12, overflowX: 'auto', whiteSpace: 'pre-wrap', wordBreak: 'break-word' }}>
      {JSON.stringify(value, null, 2)}
    </pre>
  );
  return (
    <div onClick={onClose} style={{ position: 'fixed', inset: 0, background: 'rgba(14,16,23,0.4)', zIndex: 100, display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 24 }}>
      <div onClick={(e) => e.stopPropagation()} style={{ width: 520, maxWidth: '100%', maxHeight: '80vh', overflowY: 'auto', background: 'var(--surface-raised)', borderRadius: 'var(--radius-lg)', boxShadow: 'var(--shadow-popover)', fontFamily: 'var(--font-sans)' }}>
        <div style={{ padding: '20px 20px 0', display: 'flex', alignItems: 'center', gap: 10 }}>
          <Badge status={auditStatus(entry.action)} dot={false}>{entry.action}</Badge>
        </div>
        <div style={{ padding: '16px 20px 0', display: 'flex', flexDirection: 'column', gap: 12 }}>
          {field('When', <span>{shortDate(entry.at)} · <span style={mono} title={entry.at}>{entry.at}</span></span>)}
          {field('Actor', <span style={mono}>{entry.actor}</span>)}
          {field('Entry id', <span style={mono}>{entry.id}</span>)}
          {entry.vertical && field('Vertical', entry.vertical)}
          {entry.causedBy && field('Caused by', <span><span style={mono} title={entry.causedBy}>{entry.causedBy}</span> <span style={{ color: 'var(--text-tertiary)' }}>(domain event)</span></span>)}
          {entry.before != null && field('Before', json(entry.before))}
          {entry.after != null && field('After', json(entry.after))}
        </div>
        <div style={{ display: 'flex', justifyContent: 'flex-end', padding: 20 }}>
          <Button variant="secondary" onClick={onClose}>Close</Button>
        </div>
      </div>
    </div>
  );
}
