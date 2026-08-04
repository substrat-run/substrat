import { useEffect, useMemo, useState } from 'react';
import type { CSSProperties } from 'react';
import type { EntitlementGrant, MigrationProgress, Scope, ScopeId, Tenant, TenantId } from '@substrat-run/contracts';
import { Badge, Button, Card, Dialog, Input, Select, Tabs, Tag } from '../components';
import {
  availableActions,
  effectiveStatus,
  fleetCounts,
  isSuspended,
  scopeHandle,
  statusLabel,
  statusTone,
} from '../lib/fleet';
import type { Api } from '../lib/api';

export interface ScopesProps {
  api: Api;
  scopes: Scope[];
  tenants: Map<TenantId, Tenant>;
  entitlements: Map<TenantId, EntitlementGrant[]>;
  /** Open a scope's routed detail view (App owns the URL + which scope is open). */
  onOpen: (id: ScopeId) => void;
  onChanged: () => void;
  onToast: (title: string, detail?: string, status?: 'success' | 'danger') => void;
}

function Stat({ label, value, meta }: { label: string; value: string | number; meta: string }) {
  return (
    <div
      style={{
        background: 'var(--surface-card)',
        border: '1px solid var(--border-default)',
        borderRadius: 8,
        boxShadow: 'var(--shadow-xs)',
        padding: 14,
      }}
    >
      <div
        style={{
          fontSize: 11,
          fontWeight: 500,
          letterSpacing: '0.06em',
          textTransform: 'uppercase',
          color: 'var(--text-tertiary)',
        }}
      >
        {label}
      </div>
      <div style={{ fontSize: 24, fontWeight: 600, letterSpacing: '-0.02em', color: 'var(--text-primary)', margin: '4px 0 2px' }}>
        {value}
      </div>
      <div style={{ fontSize: 12, color: 'var(--text-tertiary)' }}>{meta}</div>
    </div>
  );
}

/**
 * The §5.3 ops view (#49): "release N: X/Y migrated, P pending, F failed",
 * computed directory-side against the deployment's migration frontier. This is
 * what makes "0 failed" a measurement instead of an artifact of nobody having
 * woken the stragglers — the reconciliation sweep keeps the numbers honest.
 */
function MigrationProgressCard({ progress, tenants }: { progress: MigrationProgress; tenants: Map<TenantId, Tenant> }) {
  const flagged = progress.stragglers.filter((s) => s.flagged);
  return (
    <Card
      title="Migrations"
      description={progress.summary}
      actions={
        progress.complete ? (
          <Badge status="success">Skew window closed</Badge>
        ) : (
          <span style={{ display: 'inline-flex', gap: 6 }}>
            {progress.failed > 0 && <Badge status="danger">{progress.failed} failed</Badge>}
            {progress.pending > 0 && <Badge status="warning">{progress.pending} pending</Badge>}
            {flagged.length > 0 && <Badge status="danger">{flagged.length} past threshold</Badge>}
          </span>
        )
      }
    >
      {progress.complete ? (
        <p style={{ margin: 0, fontSize: 12.5, color: 'var(--text-tertiary)' }}>
          Every live scope is at the deployed frontier — the expand–contract gate is open:
          a destructive follow-up release may ship (kernel-design §5.3).
        </p>
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
          {progress.stragglers.map((s) => (
            <div key={s.scopeId} style={{ display: 'flex', alignItems: 'baseline', gap: 8, fontSize: 12.5 }}>
              <Badge status={s.state === 'failed' ? 'danger' : 'warning'}>{s.state}</Badge>
              <code style={{ fontSize: 12 }}>
                {tenants.get(s.tenantId)?.slug ?? '?'}/{s.slug}
              </code>
              <span style={{ color: 'var(--text-tertiary)' }}>
                schema {s.schemaVersion}/{progress.release}
                {s.failure &&
                  ` · ${s.failure.version} · ${s.failure.attempts} attempt${s.failure.attempts === 1 ? '' : 's'}${s.flagged ? ' · FLAGGED' : ''}`}
              </span>
            </div>
          ))}
          <p style={{ margin: '4px 0 0', fontSize: 12, color: 'var(--text-tertiary)' }}>
            Pending scopes migrate on next wake or sweep pass; failed scopes fail closed and are
            retried with backoff — recovery is per-scope PITR plus a patched forward release.
          </p>
        </div>
      )}
    </Card>
  );
}

/**
 * A compact table checkbox with a third, indeterminate state (some-but-not-all
 * of a select-all group checked). The shared `Checkbox` has no indeterminate
 * visual and always lays out a label line, so the table hand-rolls this one.
 */
function SelectBox({
  checked,
  indeterminate,
  onChange,
  ariaLabel,
}: {
  checked: boolean;
  indeterminate?: boolean;
  onChange: (checked: boolean) => void;
  ariaLabel: string;
}) {
  const on = checked || !!indeterminate;
  return (
    <span
      role="checkbox"
      aria-checked={indeterminate ? 'mixed' : checked}
      aria-label={ariaLabel}
      onClick={(e) => {
        // The checkbox lives inside a row whose click opens the detail panel —
        // toggling selection must not also open it.
        e.stopPropagation();
        onChange(!checked);
      }}
      style={{
        width: 16,
        height: 16,
        display: 'inline-flex',
        alignItems: 'center',
        justifyContent: 'center',
        borderRadius: 'var(--radius-xs)',
        border: '1px solid ' + (on ? 'var(--brand-600)' : 'var(--border-strong)'),
        background: on ? 'var(--brand-600)' : 'var(--surface-card)',
        cursor: 'pointer',
        flexShrink: 0,
      }}
    >
      {indeterminate ? (
        <svg viewBox="0 0 12 12" width="10" height="10">
          <path d="M2.5 6h7" fill="none" stroke="#fff" strokeWidth="1.8" strokeLinecap="round" />
        </svg>
      ) : checked ? (
        <svg viewBox="0 0 12 12" width="10" height="10">
          <path d="M2.5 6.5l2.5 2.5 4.5-5" fill="none" stroke="#fff" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
      ) : null}
    </span>
  );
}

/** The bulk levers, in the order they render. Reap is destructive and armed separately. */
type BulkAction = 'suspend' | 'unsuspend' | 'archive' | 'unarchive' | 'reap';
const BULK_ACTIONS: {
  action: BulkAction;
  label: string;
  variant: 'secondary' | 'danger';
  past: string;
}[] = [
  { action: 'unsuspend', label: 'Unsuspend', variant: 'secondary', past: 'unsuspended' },
  { action: 'unarchive', label: 'Restore', variant: 'secondary', past: 'restored' },
  { action: 'suspend', label: 'Suspend', variant: 'danger', past: 'suspended' },
  { action: 'archive', label: 'Archive', variant: 'secondary', past: 'archived' },
  { action: 'reap', label: 'Reap storage', variant: 'danger', past: 'reaped' },
];

/** Options for the client-side page-size control. */
const PAGE_SIZES = [25, 50, 100];

export function Scopes({ api, scopes, tenants, entitlements, onOpen, onChanged, onToast }: ScopesProps) {
  const [tab, setTab] = useState('all');
  // Null until it loads; stays null where the API predates /fleet/migrations —
  // the card simply does not render, nothing else degrades.
  const [migrations, setMigrations] = useState<MigrationProgress | null>(null);

  // Filters — all client-side over the walked `scopes` prop (the whole fleet is
  // already in memory, App-level `walkAll`). The tabs above own the status facet;
  // these narrow within it.
  const [q, setQ] = useState('');
  const [tenantFilter, setTenantFilter] = useState('all');
  const [verticalFilter, setVerticalFilter] = useState('all');
  const [jurisFilter, setJurisFilter] = useState('all');
  const [pageSize, setPageSize] = useState(PAGE_SIZES[0]!);
  const [pageIndex, setPageIndex] = useState(0);

  // Bulk selection, keyed by scope id so it survives the re-sliced page window.
  const [selectedIds, setSelectedIds] = useState<Set<ScopeId>>(new Set());
  // The bulk reap gate (destructive, no restore) — armed by typing the count.
  const [bulkReap, setBulkReap] = useState(false);
  const [bulkArmed, setBulkArmed] = useState('');
  const [bulkBusy, setBulkBusy] = useState(false);

  useEffect(() => {
    let cancelled = false;
    api
      .migrationProgress()
      .then((p) => {
        if (!cancelled) setMigrations(p);
      })
      .catch(() => {
        if (!cancelled) setMigrations(null);
      });
    return () => {
      cancelled = true;
    };
  }, [api, scopes]);

  const counts = useMemo(() => fleetCounts(scopes, tenants), [scopes, tenants]);
  const tenantList = useMemo(() => [...tenants.values()], [tenants]);
  const skuTotal = useMemo(
    () => [...entitlements.values()].reduce((n, keys) => n + keys.length, 0),
    [entitlements],
  );

  // The vertical facet — every distinct binding present in the fleet, so the
  // dropdown only offers verticals that can actually match.
  const verticals = useMemo(() => {
    const set = new Set<string>();
    for (const s of scopes) if (s.vertical) set.add(s.vertical);
    return [...set].sort();
  }, [scopes]);

  // The full filter pipeline, client-side over the walked fleet. The tab owns the
  // effective-status facet (cascade is a client computation the server cannot
  // filter); the rest narrow within it. Order is the directory's own.
  const filtered = useMemo(() => {
    const needle = q.trim().toLowerCase();
    return scopes.filter((s) => {
      const eff = effectiveStatus(s, tenants.get(s.tenantId));
      if (tab === 'suspended' && !isSuspended(eff)) return false;
      if (tab === 'archived' && !(eff === 'archived' || eff === 'archiving' || eff === 'reaped')) return false;
      if (tenantFilter !== 'all' && s.tenantId !== tenantFilter) return false;
      if (verticalFilter !== 'all' && (s.vertical ?? '') !== verticalFilter) return false;
      if (jurisFilter !== 'all' && s.jurisdiction !== jurisFilter) return false;
      if (needle) {
        const hay = `${s.name} ${scopeHandle(s, tenants)} ${s.slug} ${s.vertical ?? ''} ${s.kind} ${s.id}`.toLowerCase();
        if (!hay.includes(needle)) return false;
      }
      return true;
    });
  }, [scopes, tenants, tab, tenantFilter, verticalFilter, jurisFilter, q]);

  // A filter change can shrink the result below the current page — reset to the
  // first page so the operator never lands on an empty tail.
  useEffect(() => {
    setPageIndex(0);
  }, [tab, tenantFilter, verticalFilter, jurisFilter, q, pageSize]);

  const total = filtered.length;
  const pageCount = Math.max(1, Math.ceil(total / pageSize));
  const page = Math.min(pageIndex, pageCount - 1);
  const start = page * pageSize;
  const pageRows = filtered.slice(start, start + pageSize);

  // Selection is scoped to what the filters currently show: everything derived
  // from `filtered`, so a hidden-but-still-selected row never silently rides
  // along a bulk action. `selectedIds` may retain hidden ids; they simply don't
  // count until they match again.
  const selectedRows = useMemo(() => filtered.filter((s) => selectedIds.has(s.id)), [filtered, selectedIds]);
  const allSelected = filtered.length > 0 && selectedRows.length === filtered.length;
  const someSelected = selectedRows.length > 0 && !allSelected;

  function toggleOne(id: ScopeId, on: boolean) {
    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (on) next.add(id);
      else next.delete(id);
      return next;
    });
  }

  function toggleAll(on: boolean) {
    setSelectedIds((prev) => {
      const next = new Set(prev);
      for (const s of filtered) {
        if (on) next.add(s.id);
        else next.delete(s.id);
      }
      return next;
    });
  }

  function clearSelection() {
    setSelectedIds(new Set());
  }

  /** Selected rows for which `action` is a legal transition (its eligible subset). */
  function eligibleFor(action: BulkAction): Scope[] {
    return selectedRows.filter((s) =>
      availableActions(effectiveStatus(s, tenants.get(s.tenantId))).includes(action),
    );
  }

  const apiForAction: Record<BulkAction, (t: TenantId, s: ScopeId) => Promise<unknown>> = {
    suspend: api.suspendScope,
    unsuspend: api.unsuspendScope,
    archive: api.archiveScope,
    unarchive: api.unarchiveScope,
    reap: api.reapScope,
  };

  // Fan the per-scope endpoints out sequentially — each stays its own audited
  // transition, and a mid-run failure (illegal transition, race) is counted, not
  // fatal. The whole selection is refreshed and cleared once at the end.
  async function runBulk(action: BulkAction, targets: Scope[]) {
    const label = BULK_ACTIONS.find((a) => a.action === action)!.past;
    setBulkBusy(true);
    let ok = 0;
    let failed = 0;
    for (const s of targets) {
      try {
        await apiForAction[action](s.tenantId, s.id);
        ok++;
      } catch {
        failed++;
      }
    }
    setBulkBusy(false);
    clearSelection();
    onChanged();
    onToast(
      `${ok} scope${ok === 1 ? '' : 's'} ${label}`,
      failed > 0 ? `${failed} failed` : undefined,
      failed > 0 ? 'danger' : 'success',
    );
  }

  const reapTargets = eligibleFor('reap');

  const th: CSSProperties = {
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
  const td: CSSProperties = {
    padding: '0 16px',
    height: 'var(--table-row-h)',
    borderBottom: '1px solid var(--border-subtle)',
    fontSize: 14,
    whiteSpace: 'nowrap',
  };
  const anyFilter = q !== '' || tenantFilter !== 'all' || verticalFilter !== 'all' || jurisFilter !== 'all';

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 20 }}>
      <div>
        <h1 style={{ margin: 0, fontSize: 22, lineHeight: '29px', fontWeight: 600, letterSpacing: '-0.02em', color: 'var(--text-primary)' }}>
          Scopes
        </h1>
        <p style={{ margin: '4px 0 0', fontSize: 13, color: 'var(--text-tertiary)' }}>
          Fleet-wide directory — every scope is its own database and consistency domain.
        </p>
      </div>

      {/* Only what the directory and entitlement store can actually answer.
          Event counts and queue telemetry are not computable and are not shown. */}
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: 12 }}>
        <Stat label="Active scopes" value={counts.active} meta={`of ${counts.scopes} in the directory`} />
        <Stat
          label="Tenants"
          value={tenantList.length}
          meta={`${tenantList.filter((t) => t.status === 'active').length} active · ${tenantList.filter((t) => t.status !== 'active').length} not`}
        />
        <Stat
          label="Suspended scopes"
          value={counts.suspended}
          meta={counts.viaCascade > 0 ? `${counts.viaCascade} via tenant cascade` : 'none via cascade'}
        />
        <Stat label="Entitlements held" value={skuTotal} meta={`across ${entitlements.size} tenants`} />
      </div>

      {migrations && <MigrationProgressCard progress={migrations} tenants={tenants} />}

      <Tabs
        value={tab}
        onChange={setTab}
        tabs={[
          { value: 'all', label: 'All', count: counts.scopes },
          { value: 'suspended', label: 'Suspended', count: counts.suspended },
          { value: 'archived', label: 'Archived', count: counts.archived },
        ]}
      />

      {/* Filter row — the AdminLog convention: free-text search plus the facets
          the fleet actually varies over. All client-side against the walked set. */}
      <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap', alignItems: 'center' }}>
        <Input
          placeholder="Search name, slug, tenant, vertical, or id…"
          value={q}
          onChange={(e) => setQ(e.target.value)}
          style={{ width: 320 }}
        />
        <Select
          options={[{ value: 'all', label: 'All tenants' }, ...tenantList.map((t) => ({ value: t.id, label: t.slug }))]}
          value={tenantFilter}
          onChange={(e) => setTenantFilter(e.target.value)}
          style={{ width: 170 }}
        />
        <Select
          options={[
            { value: 'all', label: 'All verticals' },
            ...verticals.map((v) => ({ value: v, label: v })),
          ]}
          value={verticalFilter}
          onChange={(e) => setVerticalFilter(e.target.value)}
          style={{ width: 170 }}
        />
        <Select
          options={[
            { value: 'all', label: 'All jurisdictions' },
            { value: 'global', label: 'Global' },
            { value: 'eu', label: 'EU' },
            { value: 'us', label: 'US' },
          ]}
          value={jurisFilter}
          onChange={(e) => setJurisFilter(e.target.value)}
          style={{ width: 160 }}
        />
        {anyFilter && (
          <Button
            variant="ghost"
            size="sm"
            onClick={() => {
              setQ('');
              setTenantFilter('all');
              setVerticalFilter('all');
              setJurisFilter('all');
            }}
          >
            Clear filters
          </Button>
        )}
      </div>

      {/* Bulk action bar — only the levers legal for at least one selected scope.
          Each button carries its eligible count; the rest of the selection is left
          untouched. Reap is armed behind a confirm because it does not restore. */}
      {selectedRows.length > 0 && (
        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: 12,
            padding: '10px 14px',
            borderRadius: 8,
            border: '1px solid var(--border-default)',
            background: 'var(--surface-inset)',
            flexWrap: 'wrap',
          }}
        >
          <span style={{ fontSize: 13, fontWeight: 500, color: 'var(--text-primary)' }}>
            {selectedRows.length} selected
          </span>
          <span style={{ flex: 1 }} />
          {BULK_ACTIONS.map(({ action, label, variant }) => {
            const targets = eligibleFor(action);
            if (targets.length === 0) return null;
            return (
              <Button
                key={action}
                variant={variant}
                size="sm"
                disabled={bulkBusy}
                onClick={
                  action === 'reap'
                    ? () => {
                        setBulkArmed('');
                        setBulkReap(true);
                      }
                    : () => void runBulk(action, targets)
                }
              >
                {label} ({targets.length})
              </Button>
            );
          })}
          <Button variant="ghost" size="sm" disabled={bulkBusy} onClick={clearSelection}>
            Clear
          </Button>
        </div>
      )}

      <Card padding={0}>
        <table style={{ width: '100%', borderCollapse: 'collapse', fontFamily: 'var(--font-sans)', fontSize: 14 }}>
          <thead>
            <tr>
              <th style={{ ...th, width: 44, paddingRight: 0 }}>
                <SelectBox
                  checked={allSelected}
                  indeterminate={someSelected}
                  onChange={toggleAll}
                  ariaLabel={allSelected ? 'Deselect all' : 'Select all matching'}
                />
              </th>
              <th style={th}>Scope</th>
              <th style={th}>Slug</th>
              <th style={th}>Kind</th>
              <th style={{ ...th, textAlign: 'center' }}>Shape</th>
              <th style={th}>Jurisdiction</th>
              <th style={th}>Schema</th>
              <th style={{ ...th, textAlign: 'right' }}>Status</th>
            </tr>
          </thead>
          <tbody>
            {pageRows.map((s) => {
              const rowEff = effectiveStatus(s, tenants.get(s.tenantId));
              const checked = selectedIds.has(s.id);
              return (
                <tr
                  key={s.id}
                  onClick={() => onOpen(s.id)}
                  style={{
                    cursor: 'pointer',
                    background: checked ? 'var(--surface-hover)' : 'transparent',
                  }}
                >
                  <td style={{ ...td, paddingRight: 0 }}>
                    <SelectBox
                      checked={checked}
                      onChange={(on) => toggleOne(s.id, on)}
                      ariaLabel={`Select ${scopeHandle(s, tenants)}`}
                    />
                  </td>
                  <td style={{ ...td, color: 'var(--text-primary)' }}>{s.name}</td>
                  <td style={{ ...td, fontFamily: 'var(--font-mono)', fontSize: 12.5, color: 'var(--text-tertiary)' }}>
                    {scopeHandle(s, tenants)}
                  </td>
                  <td style={td}>
                    <Tag mono>{s.kind}</Tag>
                  </td>
                  <td style={{ ...td, textAlign: 'center', fontFamily: 'var(--font-mono)', fontSize: 12.5 }}>{s.storageShape}</td>
                  <td style={td}>
                    <Tag mono>{s.jurisdiction}</Tag>
                  </td>
                  <td style={{ ...td, fontFamily: 'var(--font-mono)', fontSize: 12.5, color: 'var(--text-tertiary)' }}>
                    {s.schemaVersion}
                  </td>
                  <td style={{ ...td, textAlign: 'right' }}>
                    <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6, justifyContent: 'flex-end' }}>
                      {/* A cascade-suspended scope's own row still says `active`. The note
                          keeps the badge from looking like a per-scope suspend to undo here. */}
                      {rowEff === 'suspended-via-tenant' && (
                        <span style={{ fontSize: 11, color: 'var(--text-tertiary)' }}>via tenant</span>
                      )}
                      {/* Migration failure is orthogonal to lifecycle status — shown beside it. */}
                      {s.migrationFailure && <Badge status="danger">Migration failed</Badge>}
                      <Badge status={statusTone(rowEff)}>{statusLabel(rowEff)}</Badge>
                    </span>
                  </td>
                </tr>
              );
            })}
            {pageRows.length === 0 && (
              <tr>
                <td colSpan={8} style={{ ...td, textAlign: 'center', color: 'var(--text-placeholder)', height: 80 }}>
                  No scopes match this filter.
                </td>
              </tr>
            )}
          </tbody>
        </table>
        {total > 0 && (
          <div
            style={{
              padding: '10px 14px',
              display: 'flex',
              alignItems: 'center',
              gap: 12,
              borderTop: '1px solid var(--border-subtle)',
              flexWrap: 'wrap',
            }}
          >
            <span style={{ fontSize: 12.5, color: 'var(--text-tertiary)' }}>
              Showing {start + 1}–{Math.min(start + pageSize, total)} of {total}
            </span>
            <Select
              size="sm"
              options={PAGE_SIZES.map((n) => ({ value: String(n), label: `${n} / page` }))}
              value={String(pageSize)}
              onChange={(e) => setPageSize(Number(e.target.value))}
              style={{ width: 110 }}
            />
            <span style={{ flex: 1 }} />
            <span style={{ fontSize: 12.5, color: 'var(--text-tertiary)' }}>
              Page {page + 1} of {pageCount}
            </span>
            <Button variant="secondary" size="sm" disabled={page === 0} onClick={() => setPageIndex(page - 1)}>
              Prev
            </Button>
            <Button variant="secondary" size="sm" disabled={page >= pageCount - 1} onClick={() => setPageIndex(page + 1)}>
              Next
            </Button>
          </div>
        )}
      </Card>

      {/* Bulk reap confirmation. Reap is irreversible, and a bulk reap multiplies
          that — so the gate is typing the exact count, forcing the operator to
          register the magnitude before it arms. Only the eligible (archived)
          subset of the selection is reaped. */}
      <Dialog
        open={bulkReap}
        title={`Reap ${reapTargets.length} scope${reapTargets.length === 1 ? '' : 's'}?`}
        danger
        confirmLabel="Reap storage"
        width={520}
        confirmDisabled={bulkArmed !== String(reapTargets.length)}
        onConfirm={
          bulkArmed === String(reapTargets.length)
            ? () => {
                const targets = reapTargets;
                setBulkReap(false);
                setBulkArmed('');
                void runBulk('reap', targets);
              }
            : undefined
        }
        onCancel={() => {
          setBulkReap(false);
          setBulkArmed('');
        }}
      >
        <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
          <p style={{ margin: 0, fontSize: 13, color: 'var(--text-secondary)', lineHeight: '19px' }}>
            This permanently wipes the Durable Object storage of{' '}
            <strong>
              {reapTargets.length} scope{reapTargets.length === 1 ? '' : 's'}
            </strong>{' '}
            — every table, event, and migration record. It <strong>cannot be undone</strong>: unlike
            archive, there is no restore. Each directory row is kept as a tombstone.
          </p>
          {/* The eligible subset — the selection may hold rows that are not
              archived (and so cannot be reaped); those are left untouched. */}
          <div
            style={{
              maxHeight: 140,
              overflowY: 'auto',
              border: '1px solid var(--border-subtle)',
              borderRadius: 6,
              padding: '6px 10px',
              fontFamily: 'var(--font-mono)',
              fontSize: 12,
              color: 'var(--text-tertiary)',
              display: 'flex',
              flexDirection: 'column',
              gap: 2,
            }}
          >
            {reapTargets.map((s) => (
              <span key={s.id}>{scopeHandle(s, tenants)}</span>
            ))}
          </div>
          <Input
            label={`Type ${reapTargets.length} to arm this action`}
            mono
            placeholder={String(reapTargets.length)}
            value={bulkArmed}
            onChange={(e) => setBulkArmed(e.target.value)}
          />
        </div>
      </Dialog>
    </div>
  );
}
