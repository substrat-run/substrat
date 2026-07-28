import { useState } from 'react';
import type { EntitlementGrant, Scope, Tenant, TenantId } from '@substrat-run/contracts';
import { Badge, Button, Card, Dialog, Input, SubIcon, SubIcons, Table, Tag } from '../components';
import type { TableColumn } from '../components';
import { ulid } from '@substrat-run/kernel';
import { tenantTone } from '../lib/fleet';
import type { Api } from '../lib/api';
import { CreateInstance } from './CreateInstance';

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
        <span style={{ display: 'inline-flex', gap: 8 }}>
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
        <Table columns={columns} rows={tenants} onRowClick={(t) => onOpen(t.id)} emptyText="No tenants yet." />
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
