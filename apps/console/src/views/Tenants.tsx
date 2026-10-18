import { useMemo, useState } from 'react';
import type { EntitlementGrant, Scope, Tenant, TenantId } from '@substrat-run/contracts';
import { Badge, Button, Card, Dialog, Input, Pager, Select, SubIcon, SubIcons, Table, Tag, usePaged } from '../components';
import type { TableColumn } from '../components';
import { ulid } from '@substrat-run/kernel';
import { tenantTone } from '../lib/fleet';
import type { Api } from '../lib/api';
import { CreateInstance } from './CreateInstance';

type Provenance = 'all' | 'direct' | 'provisioned';

export interface TenantsProps {
  api: Api;
  tenants: Tenant[];
  scopes: Scope[];
  entitlements: Map<TenantId, EntitlementGrant[]>;
  onOpen: (id: TenantId) => void;
  onChanged: () => void;
  onToast: (title: string, detail?: string, status?: 'success' | 'danger') => void;
}

export function Tenants({ api, tenants, scopes, entitlements, onOpen, onChanged, onToast }: TenantsProps) {
  const [creating, setCreating] = useState(false);
  const [instancing, setInstancing] = useState(false);
  const [slug, setSlug] = useState('');
  const [name, setName] = useState('');
  const [error, setError] = useState<string>();

  // Provenance facet (#412): a manager vertical provisions "customer" tenants inside
  // another tenant's app; this narrows the directory to first-class (direct) tenants
  // or just the provisioned ones. Client-side over the walked `tenants` prop — the
  // whole directory is already in memory (App-level walkAll), same as the Scopes facets.
  const [provenance, setProvenance] = useState<Provenance>('all');
  // Status facet: reaped tenants are tombstones (storage gone, slug burned), so the
  // default view leaves them out; 'all' brings them back.
  const [statusFilter, setStatusFilter] = useState('not-reaped');
  const [q, setQ] = useState('');

  const tenantName = useMemo(() => new Map(tenants.map((t) => [t.id, t.name])), [tenants]);

  const filtered = useMemo(
    () =>
      tenants.filter((t) => {
        if (statusFilter === 'not-reaped' ? t.status === 'reaped' : statusFilter !== 'all' && t.status !== statusFilter) {
          return false;
        }
        const needle = q.trim().toLowerCase();
        if (needle && !`${t.name} ${t.slug} ${t.id}`.toLowerCase().includes(needle)) return false;
        if (provenance === 'direct') return t.provisionedByTenant === null;
        if (provenance === 'provisioned') return t.provisionedByTenant !== null;
        return true;
      }),
    [tenants, provenance, statusFilter, q],
  );
  const paged = usePaged(filtered, `${provenance}|${statusFilter}|${q}`);
  const reapedCount = useMemo(() => tenants.filter((t) => t.status === 'reaped').length, [tenants]);
  const provisionedCount = useMemo(() => tenants.filter((t) => t.provisionedByTenant !== null).length, [tenants]);

  const scopeCount = (id: TenantId) => scopes.filter((s) => s.tenantId === id).length;

  async function create() {
    setError(undefined);
    try {
      // The id is minted here, not server-side: a caller-supplied id is what
      // makes createTenant idempotent (§4.1), so a retry re-sends the same one
      // instead of creating a second tenant.
      await api.createTenant({ id: ulid() as TenantId, slug, name });
      setCreating(false);
      setSlug('');
      setName('');
      onChanged();
      onToast('Tenant created', `${slug} · no scopes yet`);
    } catch (e) {
      setError((e as Error).message);
    }
  }

  const columns: TableColumn<Tenant>[] = [
    { header: 'Tenant', render: (t) => t.name },
    { header: 'Slug', render: (t) => t.slug, mono: true, muted: true },
    { header: 'Scopes', render: (t) => scopeCount(t.id), mono: true, align: 'right', width: 80 },
    {
      header: 'Entitlements',
      render: (t) => {
        const grants = entitlements.get(t.id) ?? [];
        if (grants.length === 0) return <span style={{ color: 'var(--text-placeholder)' }}>—</span>;
        return (
          <span style={{ display: 'inline-flex', gap: 4, flexWrap: 'wrap' }}>
            {grants.map((g) => (
              <Tag key={g.entitlementKey} mono>
                {g.entitlementKey}
              </Tag>
            ))}
          </span>
        );
      },
    },
    {
      // Provenance (#412): null = a first-class tenant staff created; set = a customer
      // account a manager vertical provisioned inside another tenant's app.
      header: 'Source',
      render: (t) =>
        t.provisionedByTenant ? (
          <Badge status="info">via {tenantName.get(t.provisionedByTenant) ?? t.provisionedByTenant}</Badge>
        ) : (
          <span style={{ color: 'var(--text-placeholder)', fontSize: 12.5 }}>Direct</span>
        ),
    },
    { header: 'Created', render: (t) => t.createdAt.slice(0, 10), mono: true, muted: true, width: 110 },
    {
      header: 'Status',
      align: 'right',
      render: (t) => <Badge status={tenantTone(t.status)}>{t.status}</Badge>,
    },
  ];

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 20 }}>
      <div style={{ display: 'flex', alignItems: 'flex-start', gap: 16 }}>
        <div style={{ flex: 1 }}>
          <h1 style={{ margin: 0, fontSize: 22, lineHeight: '29px', fontWeight: 600, letterSpacing: '-0.02em', color: 'var(--text-primary)' }}>
            Tenants
          </h1>
          <p style={{ margin: '4px 0 0', fontSize: 13, color: 'var(--text-tertiary)' }}>
            The root entity — suspending a tenant fails every scope under it closed.
          </p>
        </div>
        <span style={{ display: 'inline-flex', gap: 8, alignItems: 'center' }}>
          {/* Only offered once a provisioned tenant exists — otherwise the facet is noise. */}
          {provisionedCount > 0 && (
            <Select
              options={[
                { value: 'all', label: `All (${tenants.length})` },
                { value: 'direct', label: `Direct (${tenants.length - provisionedCount})` },
                { value: 'provisioned', label: `Provisioned (${provisionedCount})` },
              ]}
              value={provenance}
              onChange={(e) => setProvenance(e.target.value as Provenance)}
              style={{ width: 180 }}
            />
          )}
          {/* The bare tenant stays available — it is the primitive. This is the
              product action: a tenant on its own does nothing a customer can use. */}
          <Button variant="secondary" onClick={() => setCreating(true)}>
            Create tenant
          </Button>
          <Button icon={<SubIcon d={SubIcons.plus} />} onClick={() => setInstancing(true)}>
            New instance
          </Button>
        </span>
      </div>

      <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap', alignItems: 'center' }}>
        <Input
          placeholder="Search name, slug, or id…"
          value={q}
          onChange={(e) => setQ(e.target.value)}
          style={{ width: 320 }}
        />
        <Select
          options={[
            { value: 'not-reaped', label: `Hide reaped (${tenants.length - reapedCount})` },
            { value: 'all', label: `All statuses (${tenants.length})` },
            { value: 'active', label: 'Active' },
            { value: 'suspended', label: 'Suspended' },
            { value: 'deleting', label: 'Deleting' },
            { value: 'reaped', label: `Reaped (${reapedCount})` },
          ]}
          value={statusFilter}
          onChange={(e) => setStatusFilter(e.target.value)}
          style={{ width: 190 }}
        />
        {(q !== '' || statusFilter !== 'not-reaped' || provenance !== 'all') && (
          <Button
            variant="ghost"
            size="sm"
            onClick={() => {
              setQ('');
              setStatusFilter('not-reaped');
              setProvenance('all');
            }}
          >
            Clear filters
          </Button>
        )}
      </div>

      <Card padding={0}>
        <Table
          columns={columns}
          rows={paged.rows}
          onRowClick={(t) => onOpen(t.id)}
          emptyText={
            tenants.length === 0
              ? 'No tenants yet.'
              : provenance === 'provisioned' && q === '' && statusFilter === 'not-reaped'
                ? 'No provisioned tenants.'
                : 'No tenants match this filter.'
          }
        />
        <Pager p={paged} />
      </Card>

      <Dialog
        open={creating}
        title="Create tenant"
        description="Creates the tenant root only — provision its scopes afterwards."
        confirmLabel="Create tenant"
        onConfirm={create}
        onCancel={() => {
          setCreating(false);
          setError(undefined);
        }}
      >
        <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
          <Input
            label="Slug"
            mono
            placeholder="acme"
            hint="Stable, URL-safe, unique across the platform."
            value={slug}
            onChange={(e) => setSlug(e.target.value)}
            error={error}
          />
          <Input label="Name" placeholder="Acme Fastigheter" value={name} onChange={(e) => setName(e.target.value)} />
        </div>
      </Dialog>

      <CreateInstance
        api={api}
        open={instancing}
        onCancel={() => setInstancing(false)}
        onDone={(summary) => {
          setInstancing(false);
          onChanged();
          onToast('Instance created', summary);
        }}
        onFailed={(message) => {
          // Not dismissed on failure: the step list shows how far it got, and that
          // is the only place the operator can see whether the vertical provisioned
          // before the directory row did.
          onToast('Instance creation failed', message, 'danger');
        }}
      />
    </div>
  );
}
