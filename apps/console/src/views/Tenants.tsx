import { useEffect, useMemo, useState } from 'react';
import type { EntitlementGrant, Scope, Tenant, TenantId } from '@substrat-run/contracts';
import { Badge, Button, Card, Dialog, Input, Select, SubIcon, SubIcons, Table, Tag } from '../components';
import type { TableColumn } from '../components';
import { ulid } from '@substrat-run/kernel';
import { tenantTone } from '../lib/fleet';
import type { Api } from '../lib/api';
import { CreateInstance } from './CreateInstance';

/** Client-side page window over the walked set (matches the Scopes/Verticals convention). */
const PAGE = 20;

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
  const [shown, setShown] = useState(PAGE);

  const tenantName = useMemo(() => new Map(tenants.map((t) => [t.id, t.name])), [tenants]);

  const filtered = useMemo(
    () =>
      tenants.filter((t) => {
        if (provenance === 'direct') return t.provisionedByTenant === null;
        if (provenance === 'provisioned') return t.provisionedByTenant !== null;
        return true;
      }),
    [tenants, provenance],
  );
  // A filter change can shrink the set below the window — reset so no empty tail shows.
  useEffect(() => setShown(PAGE), [provenance]);
  const rows = filtered.slice(0, shown);
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

      <Card padding={0}>
        <Table
          columns={columns}
          rows={rows}
          onRowClick={(t) => onOpen(t.id)}
          emptyText={provenance === 'provisioned' ? 'No provisioned tenants.' : 'No tenants yet.'}
        />
        {filtered.length > shown && (
          <div style={{ padding: 12, display: 'flex', justifyContent: 'center' }}>
            <Button variant="ghost" size="sm" onClick={() => setShown((n) => n + PAGE)}>
              Load more
            </Button>
          </div>
        )}
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
