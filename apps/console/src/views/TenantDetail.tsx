import { useEffect, useState } from 'react';
import type { EntitlementGrant, EntitlementGrantInput, HostnameBinding, Scope, Tenant, TenantId } from '@substrat-run/contracts';
import { Badge, Button, Card, Dialog, Input, Select, Table, Tag } from '../components';
import type { TableColumn } from '../components';
import { effectiveStatus, statusLabel, statusTone, tenantTone } from '../lib/fleet';
import { portalUrl } from '../lib/portal';
import { d1DatabaseUrl, r2BucketUrl, type PlatformRuntime, type TenantStores } from '../lib/cf-links';
import type { Api } from '../lib/api';

/** One row of the store inventory below — the two ledgers flattened into the one
 *  question staff actually ask: what holds this tenant's bytes, and where is it? */
interface StoreRow {
  kind: 'D1' | 'R2';
  binding: string;
  vertical: string;
  ref: string;
  href: string | null;
  createdAt: string;
}

function storeRows(stores: TenantStores | null, runtime: PlatformRuntime | null): StoreRow[] {
  if (!stores) return [];
  return [
    ...stores.tenantStores.map((s) => ({
      kind: 'D1' as const,
      binding: s.binding,
      vertical: s.vertical,
      ref: s.ref,
      href: d1DatabaseUrl(runtime, s.ref),
      createdAt: s.createdAt,
    })),
    ...stores.blobStores.map((s) => ({
      kind: 'R2' as const,
      binding: s.binding,
      vertical: s.vertical,
      ref: s.ref,
      href: r2BucketUrl(runtime, s.ref),
      createdAt: s.createdAt,
    })),
  ];
}

/**
 * The console-maintained SKU list. The platform has NO entitlement-key catalogue
 * — `operationEntitlement` is a private in-memory map on the host, built from
 * manifests at registration. So this list is the console's own guess, and the UI
 * says so rather than implying the platform validated it. Granting an unknown key
 * silently does nothing useful; that is worth not hiding.
 */
const KNOWN_SKUS = ['workorder', 'invoicing', 'protocol', 'shop'];

/** The ref is the row's whole point, so it carries the link — and stays readable as a
 *  plain id when there is no runtime to link into (self-host, or an unconfigured CP). */
const storeColumns: TableColumn<StoreRow>[] = [
  { header: 'Kind', render: (r) => <Tag mono>{r.kind}</Tag>, width: 72 },
  { header: 'Binding', render: (r) => r.binding, mono: true },
  { header: 'Vertical', render: (r) => r.vertical, mono: true, muted: true },
  {
    header: 'Ref',
    // A D1 id is short; a deterministic bucket name is not, and an unbounded ref pushes
    // the rest of the row off the card. Clipped with the full value on hover — the ref is
    // for following, and the link already carries it.
    render: (r) => {
      const clip = {
        display: 'inline-block',
        maxWidth: 340,
        overflow: 'hidden',
        textOverflow: 'ellipsis',
        whiteSpace: 'nowrap',
        verticalAlign: 'bottom',
      } as const;
      return r.href ? (
        <a
          href={r.href}
          target="_blank"
          rel="noreferrer"
          title={r.ref}
          style={{ ...clip, color: 'var(--brand-700)' }}
        >
          {r.ref} ↗
        </a>
      ) : (
        <span title={r.ref} style={clip}>
          {r.ref}
        </span>
      );
    },
    mono: true,
  },
  { header: 'Minted', render: (r) => r.createdAt.slice(0, 10), mono: true, muted: true },
];

export interface TenantDetailProps {
  api: Api;
  tenant: Tenant;
  scopes: Scope[];
  entitlements: EntitlementGrant[];
  hostnames: HostnameBinding[];
  /** Where this platform runs — turns store refs into dashboard links. Null = none. */
  runtime: PlatformRuntime | null;
  /** Display name of the tenant that provisioned this one (#412), if any. */
  provisionedByName?: string;
  /** Open another tenant's detail (used by the provenance link to the parent). */
  onOpen?: (id: TenantId) => void;
  onBack: () => void;
  onChanged: () => void;
  onToast: (title: string, detail?: string, status?: 'success' | 'danger') => void;
}

export function TenantDetail({ api, tenant, scopes, entitlements, hostnames, runtime, provisionedByName, onOpen, onBack, onChanged, onToast }: TenantDetailProps) {
  const [confirmSuspend, setConfirmSuspend] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [confirmReap, setConfirmReap] = useState(false);
  const [armed, setArmed] = useState('');
  const [granting, setGranting] = useState(false);
  const [sku, setSku] = useState(KNOWN_SKUS[0]!);
  // The plan half of a grant (#33) — all optional; blank = a bare perpetual flag.
  const [expiry, setExpiry] = useState('');
  const [quota, setQuota] = useState('');
  const [plan, setPlan] = useState('');
  // The platform-minted stores backing this tenant (#301/#473). Read on open rather than
  // with the directory: it is one tenant's inventory, and a control plane that mints no
  // stores (self-host, pure adapter) simply answers empty. A failed read is silent — the
  // card is an operator aid, not a lifecycle lever.
  const [stores, setStores] = useState<TenantStores | null>(null);
  useEffect(() => {
    let cancelled = false;
    setStores(null);
    api
      .tenantStores(tenant.id)
      .then((s) => {
        if (!cancelled) setStores(s);
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [api, tenant.id]);

  async function run(fn: () => Promise<unknown>, title: string, detail?: string) {
    try {
      await fn();
      onChanged();
      onToast(title, detail);
    } catch (e) {
      onToast('Refused', (e as Error).message, 'danger');
    }
  }

  const columns: TableColumn<Scope>[] = [
    { header: 'Scope', render: (s) => s.name },
    { header: 'Slug', render: (s) => s.slug, mono: true, muted: true },
    {
      header: 'Vertical',
      render: (s) => (s.vertical ? <Tag mono>{s.vertical}</Tag> : <span style={{ color: 'var(--text-placeholder)' }}>—</span>),
    },
    { header: 'Kind', render: (s) => <Tag mono>{s.kind}</Tag> },
    {
      header: 'Status',
      align: 'right',
      render: (s) => {
        const eff = effectiveStatus(s, tenant);
        return <Badge status={statusTone(eff)}>{statusLabel(eff)}</Badge>;
      },
    },
    {
      // The tenant-facing portal for this scope's vertical, from the scope's
      // canonical hostname. Null — so no link — until a binding is ACTIVE: a
      // hostname still validating DNS would render a link that leads nowhere.
      header: '',
      align: 'right',
      width: 96,
      render: (s) => {
        const url = portalUrl(s, hostnames);
        if (!url) return null;
        return (
          <a
            href={url}
            target="_blank"
            rel="noreferrer"
            onClick={(e) => e.stopPropagation()}
            style={{ fontSize: 12.5, fontWeight: 500, color: 'var(--brand-700)', textDecoration: 'none', whiteSpace: 'nowrap' }}
          >
            Portal ↗
          </a>
        );
      },
    },
  ];

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 20 }}>
      <div style={{ display: 'flex', alignItems: 'flex-start', gap: 16 }}>
        <div style={{ flex: 1 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
            <h1 style={{ margin: 0, fontSize: 22, lineHeight: '29px', fontWeight: 600, letterSpacing: '-0.02em', color: 'var(--text-primary)' }}>
              {tenant.name}
            </h1>
            <Badge status={tenantTone(tenant.status)}>{tenant.status}</Badge>
          </div>
          <p style={{ margin: '4px 0 0', fontSize: 13, color: 'var(--text-tertiary)', fontFamily: 'var(--font-mono)' }}>
            {tenant.slug} · created {tenant.createdAt.slice(0, 10)}
          </p>
          {/* Provenance (#412): a manager vertical provisioned this tenant inside another
              tenant's app — link back to that provisioner so the relationship is walkable. */}
          {tenant.provisionedByTenant && (
            <p style={{ margin: '4px 0 0', fontSize: 12.5, color: 'var(--text-tertiary)' }}>
              Provisioned by{' '}
              {onOpen ? (
                <button
                  type="button"
                  onClick={() => onOpen(tenant.provisionedByTenant!)}
                  style={{
                    background: 'none',
                    border: 'none',
                    padding: 0,
                    font: 'inherit',
                    color: 'var(--brand-700)',
                    fontWeight: 500,
                    cursor: 'pointer',
                  }}
                >
                  {provisionedByName ?? tenant.provisionedByTenant}
                </button>
              ) : (
                <strong>{provisionedByName ?? tenant.provisionedByTenant}</strong>
              )}
            </p>
          )}
        </div>
        <Button variant="secondary" onClick={onBack}>
          All tenants
        </Button>
        {tenant.status === 'active' && (
          <>
            <Button variant="danger" onClick={() => setConfirmSuspend(true)}>
              Suspend tenant
            </Button>
            <Button variant="danger" onClick={() => setConfirmDelete(true)}>
              Delete tenant
            </Button>
          </>
        )}
        {tenant.status === 'suspended' && (
          <Button onClick={() => run(() => api.setTenantStatus(tenant.id, 'active'), 'Tenant unsuspended', tenant.slug)}>
            Unsuspend tenant
          </Button>
        )}
        {tenant.status === 'deleting' && (
          <>
            <Button onClick={() => run(() => api.setTenantStatus(tenant.id, 'active'), 'Deletion cancelled', `${tenant.slug} restored`)}>
              Un-delete
            </Button>
            <Button variant="danger" onClick={() => setConfirmReap(true)}>
              Reap now
            </Button>
          </>
        )}
        {/* `reaped` is terminal — the data is gone; only the tombstone remains. */}
      </div>
      {tenant.status === 'deleting' && (
        <div
          style={{
            background: 'var(--status-danger-bg)',
            border: '1px solid var(--border-subtle)',
            borderRadius: 8,
            padding: '10px 12px',
            fontSize: 12.5,
            color: 'var(--text-secondary)',
            lineHeight: '18px',
          }}
        >
          <strong>Marked for deletion.</strong> Every scope fails closed now, but nothing is destroyed yet —
          <strong> Un-delete</strong> restores the tenant. After the retention window (or <strong>Reap now</strong>)
          all scope data and the tenant's identities, roles, entitlements, and orgs are permanently erased; the tenant
          row and audit log survive as a tombstone.
          {tenant.deletingAt && (
            <span style={{ fontFamily: 'var(--font-mono)', color: 'var(--text-tertiary)' }}>
              {' '}· deleting since {tenant.deletingAt.slice(0, 10)}
            </span>
          )}
        </div>
      )}
      {tenant.status === 'reaped' && (
        <div
          style={{
            background: 'var(--status-danger-bg)',
            border: '1px solid var(--border-subtle)',
            borderRadius: 8,
            padding: '10px 12px',
            fontSize: 12.5,
            color: 'var(--text-secondary)',
            lineHeight: '18px',
          }}
        >
          <strong>Reaped.</strong> This tenant's data was permanently destroyed. The row and audit log are kept as a
          tombstone and the slug stays burned — there is no restore.
        </div>
      )}

      <Card
        title="Scopes in this tenant"
        description="The fleet directory is the canonical list — this is the subset under this tenant."
        padding={0}
      >
        <Table columns={columns} rows={scopes} emptyText="No scopes provisioned yet." />
      </Card>

      <Card
        title="Entitlements"
        description="Per-tenant SKU keys. A module whose key isn't held doesn't register — its operations simply don't resolve."
        actions={<Button variant="secondary" onClick={() => setGranting(true)}>Grant key</Button>}
        footer="The platform has no key catalogue — this list is maintained by the console."
      >
        {entitlements.length === 0 ? (
          <span style={{ fontSize: 13, color: 'var(--text-placeholder)' }}>No keys held — no billed module loads for this tenant.</span>
        ) : (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
            {entitlements.map((g) => {
              // Mirrors the gate's lazy-at-read predicate: expired = fails closed.
              const expired = g.expiresAt !== null && g.expiresAt <= new Date().toISOString();
              return (
                <div key={g.entitlementKey} style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                  <Tag mono>{g.entitlementKey}</Tag>
                  {g.plan && <Tag>{g.plan}</Tag>}
                  {g.quota !== null && <Tag mono>×{g.quota}</Tag>}
                  <span style={{ fontSize: 12.5, color: expired ? 'var(--status-danger-fg)' : 'var(--text-tertiary)', flex: 1 }}>
                    {expired
                      ? `expired ${g.expiresAt!.slice(0, 10)} · fails closed`
                      : g.expiresAt
                        ? `held · expires ${g.expiresAt.slice(0, 10)}`
                        : 'held'}
                  </span>
                  <Button
                    variant="ghost"
                    size="sm"
                    onClick={() =>
                      run(
                        () => api.revokeEntitlement(tenant.id, g.entitlementKey),
                        'Entitlement revoked',
                        `${g.entitlementKey} · operations stop resolving`,
                      )
                    }
                  >
                    Revoke
                  </Button>
                </div>
              );
            })}
          </div>
        )}
      </Card>

      {/* The tenant's platform-minted stores. Provisioning mints these per (tenant,
          vertical, binding) and they are invisible everywhere else in the console — an
          operator chasing "which database is this tenant's" had only the ledger, which no
          surface exposed. Read-only by construction: nothing here mints or drops a store. */}
      <Card
        title="Stores"
        description="Per-tenant databases and buckets, minted at provisioning from what each vertical declared."
        padding={0}
        footer={
          runtime
            ? `Account ${runtime.accountId} — refs link to the Cloudflare dashboard.`
            : 'No platform runtime configured — refs shown without dashboard links.'
        }
      >
        <Table
          columns={storeColumns}
          rows={storeRows(stores, runtime)}
          emptyText={
            stores === null
              ? 'Loading…'
              : 'No stores minted — this tenant’s verticals declare none (scope data lives in Durable Objects).'
          }
        />
      </Card>

      {/* The blast-radius confirmation. Suspending a tenant is a one-click outage
          for a paying customer (§7), and the radius is exactly the list below —
          every scope fails closed the moment this confirms.

          DEVIATION FROM THE DESIGN, deliberately: the handoff specs a four-eyes
          flow here — the button reads "Request suspension" and toasts "awaiting
          second-administrator approval". There is no pending-approval store
          anywhere in the platform, so that button would suspend the tenant
          IMMEDIATELY while telling the operator it had merely queued a request.
          A console that misreports what it just did to a paying customer's fleet
          is worse than one without the feature. The type-to-arm gate below is
          real friction and is kept; four-eyes lands when it has a backing store.
          (Kernel open question 14 — the action list was supposed to settle it,
          and the action list is now real.) */}
      <Dialog
        open={confirmSuspend}
        title={`Suspend tenant ${tenant.slug}?`}
        danger
        confirmLabel="Suspend tenant"
        width={520}
        onConfirm={
          armed === tenant.slug
            ? () => {
                setConfirmSuspend(false);
                setArmed('');
                void run(
                  () => api.setTenantStatus(tenant.id, 'suspended'),
                  'Tenant suspended',
                  `${scopes.length} scope${scopes.length === 1 ? '' : 's'} now fail closed`,
                );
              }
            : undefined
        }
        onCancel={() => {
          setConfirmSuspend(false);
          setArmed('');
        }}
      >
        <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
          <p style={{ margin: 0, fontSize: 13, color: 'var(--text-secondary)', lineHeight: '19px' }}>
            This is a tenant-wide outage. Every scope below <strong>fails closed</strong> the moment you confirm —
            operations rejected, reads refused.
          </p>
          <div
            style={{
              background: 'var(--status-danger-bg)',
              border: '1px solid var(--border-subtle)',
              borderRadius: 8,
              padding: 10,
              display: 'flex',
              flexDirection: 'column',
              gap: 6,
              maxHeight: 180,
              overflow: 'auto',
            }}
          >
            {scopes.map((s) => (
              <div key={s.id} style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 12.5 }}>
                <span style={{ fontFamily: 'var(--font-mono)', color: 'var(--text-primary)', flex: 1 }}>
                  {tenant.slug}/{s.slug}
                </span>
                {s.vertical && <Tag mono>{s.vertical}</Tag>}
                <Badge status={statusTone(effectiveStatus(s, tenant))}>{statusLabel(effectiveStatus(s, tenant))}</Badge>
                <span style={{ color: 'var(--status-danger-fg)', fontFamily: 'var(--font-mono)', fontSize: 12 }}>
                  → fails closed
                </span>
              </div>
            ))}
            {scopes.length === 0 && (
              <span style={{ fontSize: 12.5, color: 'var(--text-tertiary)' }}>No scopes — nothing goes dark.</span>
            )}
          </div>
          <span style={{ fontSize: 12, color: 'var(--text-tertiary)' }}>
            {scopes.length} scope{scopes.length === 1 ? '' : 's'} affected · a paying customer goes dark.
          </span>
          <Input
            label="Type the tenant slug to arm this action"
            mono
            placeholder={tenant.slug}
            value={armed}
            onChange={(e) => setArmed(e.target.value)}
          />
        </div>
      </Dialog>

      {/* Start the reversible grace window (§4.8). A plain status flip to `deleting`
          — every scope fails closed like a suspend, but no data is reclaimed until a
          reap. Same type-to-arm friction as suspend. */}
      <Dialog
        open={confirmDelete}
        title={`Delete tenant ${tenant.slug}?`}
        danger
        confirmLabel="Start deletion"
        width={520}
        onConfirm={
          armed === tenant.slug
            ? () => {
                setConfirmDelete(false);
                setArmed('');
                void run(
                  () => api.setTenantStatus(tenant.id, 'deleting'),
                  'Deletion started',
                  'Reversible during the grace window',
                );
              }
            : undefined
        }
        onCancel={() => {
          setConfirmDelete(false);
          setArmed('');
        }}
      >
        <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
          <p style={{ margin: 0, fontSize: 13, color: 'var(--text-secondary)', lineHeight: '19px' }}>
            This marks the tenant for deletion. Every scope <strong>fails closed</strong> immediately, but{' '}
            <strong>no data is reclaimed yet</strong> — you can <strong>Un-delete</strong> to restore it. After the
            retention window (or a staff <strong>Reap now</strong>) every scope's storage is wiped and the tenant's
            identities, roles, entitlements, and orgs are <strong>permanently destroyed</strong>. The tenant row and
            audit log are kept as a tombstone.
          </p>
          <Input
            label="Type the tenant slug to arm this action"
            mono
            placeholder={tenant.slug}
            value={armed}
            onChange={(e) => setArmed(e.target.value)}
          />
        </div>
      </Dialog>

      {/* Reap now (§4.8) — skip the grace window and destroy the tenant. Irreversible:
          every scope is reaped and the PII/config directory rows are cleared, the row +
          admin log kept as a tombstone. The same type-to-arm gate the scope reap uses. */}
      <Dialog
        open={confirmReap}
        title={`Reap tenant ${tenant.slug} now?`}
        danger
        confirmLabel="Reap tenant"
        width={520}
        onConfirm={
          armed === tenant.slug
            ? () => {
                setConfirmReap(false);
                setArmed('');
                void run(
                  () => api.reapTenant(tenant.id),
                  'Tenant reaped',
                  `${scopes.length} scope${scopes.length === 1 ? '' : 's'} destroyed · tombstone kept`,
                );
              }
            : undefined
        }
        onCancel={() => {
          setConfirmReap(false);
          setArmed('');
        }}
      >
        <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
          <p style={{ margin: 0, fontSize: 13, color: 'var(--text-secondary)', lineHeight: '19px' }}>
            <strong>Irreversible.</strong> This skips the grace window and destroys the tenant now: every scope's
            storage is wiped and its identities, roles, entitlements, and orgs are deleted. The tenant row and admin
            log survive as a tombstone (the slug stays burned). <strong>There is no restore.</strong>
          </p>
          <Input
            label="Type the tenant slug to arm this action"
            mono
            placeholder={tenant.slug}
            value={armed}
            onChange={(e) => setArmed(e.target.value)}
          />
        </div>
      </Dialog>

      <Dialog
        open={granting}
        title="Grant entitlement"
        description="Idempotent and audited. Re-granting with different plan fields is a renewal; blank fields leave what the grant already carries."
        confirmLabel="Grant"
        onConfirm={() => {
          // Blank = omitted (PATCH semantics: the store preserves current values).
          const planInput: EntitlementGrantInput = {};
          if (expiry.trim() !== '') {
            const at = new Date(expiry.trim());
            if (Number.isNaN(at.getTime())) {
              onToast('Refused', `not a date: ${expiry}`, 'danger');
              return;
            }
            planInput.expiresAt = at.toISOString() as EntitlementGrant['expiresAt'];
          }
          if (quota.trim() !== '') {
            const n = Number(quota.trim());
            if (!Number.isInteger(n) || n <= 0) {
              onToast('Refused', `quota must be a positive integer: ${quota}`, 'danger');
              return;
            }
            planInput.quota = n;
          }
          if (plan.trim() !== '') planInput.plan = plan.trim();
          setGranting(false);
          void run(() => api.grantEntitlement(tenant.id, sku, planInput), 'Entitlement granted', sku);
        }}
        onCancel={() => setGranting(false)}
      >
        <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
          <Select label="SKU key" options={KNOWN_SKUS} value={sku} onChange={(e) => setSku(e.target.value)} />
          <Input
            label="Expires"
            hint="Optional — a date (UTC midnight) or full ISO instant. Past it, the grant fails closed like a revoke; the row stays for renewal."
            mono
            placeholder="2026-08-31"
            value={expiry}
            onChange={(e) => setExpiry(e.target.value)}
          />
          <Input
            label="Quota"
            hint="Optional — plan quantity for this key. Recorded, not enforced here (#33)."
            mono
            placeholder="500"
            value={quota}
            onChange={(e) => setQuota(e.target.value)}
          />
          <Input
            label="Plan"
            hint="Optional — tier grouping, e.g. pro."
            mono
            placeholder="pro"
            value={plan}
            onChange={(e) => setPlan(e.target.value)}
          />
        </div>
      </Dialog>
    </div>
  );
}
