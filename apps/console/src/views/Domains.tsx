import { useMemo, useState } from 'react';
import type {
  HostnameBinding,
  HostnameStatus,
  Scope,
  ScopeId,
  Tenant,
  TenantId,
} from '@substrat-run/contracts';
import { Badge, Button, Card, Table, Tag } from '../components';
import type { TableColumn } from '../components';
import { scopeHandle } from '../lib/fleet';
import type { Api } from '../lib/api';
import { usePagedList } from '../lib/use-paged-list';

/**
 * Domains — the hostname map (control-plane.md §4.7, K-26).
 *
 * A provisioned scope had no URL; the console faked it with an env var. This is
 * where a scope gets a real one, and where "why does it not work yet" has an answer
 * that is a status rather than a shrug.
 *
 * What is NOT here: `resolveHostname`. That is the router's per-request path,
 * deliberately unaudited (K-24), and it does not belong on a staff surface.
 */

export interface DomainsProps {
  api: Api;
  scopes: Scope[];
  tenants: Map<TenantId, Tenant>;
  hostnames: HostnameBinding[];
  onChanged: () => void;
  onToast: (title: string, detail?: string, status?: 'success' | 'danger') => void;
}

/**
 * Provisioning is not built yet (the Cloudflare for SaaS custom-hostnames API, DNS
 * validation, cert issuance), so status is set by hand here. The tones say what each
 * state means for traffic: only `active` serves, and `failed` is not the same as
 * "not yet" — which is the distinction the column exists to keep.
 */
const STATUS_TONE: Record<HostnameStatus, 'success' | 'warning' | 'danger' | 'neutral'> = {
  active: 'success',
  verifying: 'warning',
  pending: 'neutral',
  failed: 'danger',
};

const STATUS_HELP: Record<HostnameStatus, string> = {
  pending: 'Recorded. Nothing has been asked of DNS yet — does not serve traffic.',
  verifying: 'DNS validation and certificate issuance in flight — does not serve traffic yet.',
  active: 'Serving. The router resolves this hostname to the scope.',
  failed: 'Validation or issuance failed. Does not serve traffic; see the note.',
};

export function Domains({ api, scopes, tenants, hostnames, onChanged, onToast }: DomainsProps) {
  const [hostname, setHostname] = useState('');
  const [scopeKey, setScopeKey] = useState('');
  const [surface, setSurface] = useState('app');
  const [canonical, setCanonical] = useState(true);
  const [busy, setBusy] = useState(false);

  // The table pages (cursor-walked); the `hostnames` prop stays the walked map —
  // portal links elsewhere read it — and doubles as the mutation-refresh signal.
  // The bind form's scope dropdown keeps the walked `scopes`: picking a scope is a
  // whole-directory computation, not a page of one.
  const paged = usePagedList(
    (p) => api.listHostnames(p),
    [api, hostnames],
    (e) => onToast('Failed to load hostnames', e.message, 'danger'),
  );

  const bindable = useMemo(() => scopes.filter((s) => s.status !== 'archived'), [scopes]);
  const scopeById = useMemo(() => new Map(scopes.map((s) => [s.id, s])), [scopes]);

  async function run(fn: () => Promise<unknown>, title: string, detail?: string) {
    setBusy(true);
    try {
      await fn();
      onToast(title, detail, 'success');
      onChanged();
    } catch (e) {
      onToast('Failed', (e as Error).message, 'danger');
    } finally {
      setBusy(false);
    }
  }

  async function bind() {
    const scope = scopeById.get(scopeKey as ScopeId);
    if (!scope || !hostname.trim()) return;
    const name = hostname.trim().toLowerCase();
    await run(
      () =>
        api.bindHostname({
          hostname: name,
          tenantId: scope.tenantId,
          scopeId: scope.id,
          surface: surface.trim() || 'app',
          region: null,
          canonical,
        }),
      'Hostname bound',
      `${name} → ${scope.slug} · pending until activated`,
    );
    setHostname('');
  }

  const columns: TableColumn<HostnameBinding>[] = [
    {
      key: 'hostname',
      header: 'Hostname',
      render: (h) => (
        <span style={{ display: 'inline-flex', gap: 8, alignItems: 'center' }}>
          <span style={{ fontWeight: 500 }}>{h.hostname}</span>
          {h.canonical && <Tag>canonical</Tag>}
        </span>
      ),
    },
    {
      header: 'Scope',
      render: (h) => {
        const scope = scopeById.get(h.scopeId);
        return scope ? scopeHandle(scope, tenants) : h.scopeId;
      },
    },
    { key: 'surface', header: 'Surface', render: (h) => <Tag>{h.surface}</Tag> },
    {
      key: 'region',
      header: 'Region',
      // Null is the common case and means unconstrained, not unknown.
      render: (h) => (h.region ? <Tag>{h.region.toUpperCase()}</Tag> : '—'),
    },
    {
      key: 'status',
      header: 'Status',
      render: (h) => (
        <span title={STATUS_HELP[h.status]} style={{ display: 'inline-flex', gap: 8, alignItems: 'center' }}>
          <Badge status={STATUS_TONE[h.status]}>{h.status}</Badge>
          {h.statusNote && (
            <span style={{ fontSize: 12, color: 'var(--text-tertiary)' }}>{h.statusNote}</span>
          )}
        </span>
      ),
    },
    {
      header: '',
      align: 'right',
      render: (h) => (
        <span style={{ display: 'inline-flex', gap: 6, justifyContent: 'flex-end' }}>
          {h.status !== 'active' && (
            <Button
              disabled={busy}
              onClick={() =>
                run(
                  () => api.setHostnameStatus(h.hostname, 'active'),
                  'Hostname active',
                  `${h.hostname} now resolves`,
                )
              }
            >
              Activate
            </Button>
          )}
          {h.status === 'active' && (
            <Button
              variant="danger"
              disabled={busy}
              onClick={() =>
                run(
                  () => api.setHostnameStatus(h.hostname, 'failed', 'deactivated from the console'),
                  'Hostname deactivated',
                  `${h.hostname} stops resolving`,
                )
              }
            >
              Deactivate
            </Button>
          )}
        </span>
      ),
    },
  ];

  return (
    <div style={{ display: 'grid', gap: 16 }}>
      <Card
        title="Bind a hostname"
        description="The router resolves hostname → (tenant, scope, surface). A binding does not serve traffic until it is active."
      >
        <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap', alignItems: 'flex-end' }}>
          <Field label="Hostname" hint="e.g. acme.example.com">
            <input
              value={hostname}
              onChange={(e) => setHostname(e.target.value)}
              placeholder="acme.example.com"
              style={INPUT}
            />
          </Field>
          <Field label="Scope">
            <select value={scopeKey} onChange={(e) => setScopeKey(e.target.value)} style={INPUT}>
              <option value="">Select a scope…</option>
              {bindable.map((s) => (
                <option key={s.id} value={s.id}>
                  {scopeHandle(s, tenants)}
                </option>
              ))}
            </select>
          </Field>
          {/* A scope can front more than one app — the shop's storefront and back
              office, RallyPoint's player app and manager console. Free text, because
              the surface name is the VERTICAL's vocabulary; the kernel never
              branches on it. */}
          <Field label="Surface" hint="app · storefront · back-office">
            <input value={surface} onChange={(e) => setSurface(e.target.value)} style={{ ...INPUT, width: 150 }} />
          </Field>
          <Field label="Canonical" hint="one per scope + surface">
            <label style={{ display: 'inline-flex', gap: 6, alignItems: 'center', height: 34, fontSize: 13 }}>
              <input type="checkbox" checked={canonical} onChange={(e) => setCanonical(e.target.checked)} />
              Primary for this surface
            </label>
          </Field>
          <Button onClick={() => void bind()} disabled={busy || !scopeKey || !hostname.trim()}>
            Bind
          </Button>
        </div>
      </Card>

      <Card padding={0}>
        <Table
          columns={columns}
          rows={paged.entries}
          emptyText="No hostnames bound. A scope with no hostname is unreachable — the router will not serve a name it does not know."
        />
        {paged.nextCursor && (
          <div style={{ padding: 12, display: 'flex', justifyContent: 'center' }}>
            <Button variant="ghost" size="sm" onClick={() => void paged.loadMore()}>
              Load more
            </Button>
          </div>
        )}
      </Card>

      <Card title="Not built yet" description="Stated rather than implied, so the gap is visible.">
        <ul style={{ margin: 0, paddingLeft: 18, fontSize: 13, color: 'var(--text-secondary)', display: 'grid', gap: 6 }}>
          <li>
            <strong>Provisioning.</strong> DNS validation and certificate issuance (Cloudflare for
            SaaS) are not wired, so <em>Activate</em> sets the status by hand rather than reflecting
            a real certificate. A wildcard under a domain we control works until they are.
          </li>
          <li>
            <strong>Regions.</strong> Bindings are created unconstrained. Pinning processing to the
            EU needs Regional Services, an Enterprise add-on.
          </li>
        </ul>
      </Card>
    </div>
  );
}

const INPUT: React.CSSProperties = {
  height: 34,
  padding: '0 10px',
  fontSize: 13,
  borderRadius: 6,
  border: '1px solid var(--border-default)',
  background: 'var(--surface-card)',
  color: 'var(--text-primary)',
  minWidth: 220,
};

function Field({
  label,
  hint,
  children,
}: {
  label: string;
  hint?: string;
  children: React.ReactNode;
}) {
  return (
    <label style={{ display: 'grid', gap: 4 }}>
      <span style={{ fontSize: 11, fontWeight: 500, letterSpacing: '0.06em', textTransform: 'uppercase', color: 'var(--text-tertiary)' }}>
        {label}
      </span>
      {children}
      {hint && <span style={{ fontSize: 11, color: 'var(--text-tertiary)' }}>{hint}</span>}
    </label>
  );
}
