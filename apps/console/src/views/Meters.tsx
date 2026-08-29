import { useCallback, useEffect, useState } from 'react';
import type {
  EntitlementMeterRow,
  MeterReading,
  ModelUsageSummary,
  ModelUsageSummaryRow,
  Tenant,
  TenantId,
  TenantMeterRow,
} from '@substrat-run/contracts';
import { Badge, Button, Card, Stat, Table, Tag } from '../components';
import type { TableColumn } from '../components';
import { tenantTone } from '../lib/fleet';
import type { Api } from '../lib/api';

/**
 * §5's meters, rendered (#38) — and the two that are missing, said out loud.
 *
 * §5 is titled "meter, do not bill", and this view is the whole of what that decision
 * asks for: the numbers that are honestly computable, displayed, with no invoice
 * anywhere near them. Meter 1 (tenants + active scopes) and meter 2 (per-engine
 * licensing) come from the directory as one server-side reading — deliberately NOT
 * re-derived here from `listScopes`, because the billable rule is commercial and must
 * have one definition (`foldMeterReading`), not one per surface.
 *
 * Meter 3 arrived with #1054, for ONE kind of usage: model calls a vertical makes
 * through the platform's model host raise a `model-usage` intent, the drain lands it in
 * the directory, and that IS the cross-tenant fan-in D-30 said the outbox lacked. The
 * summary is folded platform-side (`foldModelUsage`) with the platform's margin applied
 * at read time, so this view shows list and billed side by side and computes neither.
 * Reads still emit nothing and the cross-tenant order flow still does not exist, so
 * meter 4 stays absent and says so.
 */

export interface MetersProps {
  api: Api;
  tenants: Map<TenantId, Tenant>;
  /** Drill into a tenant — the meter is the fleet's index into who is costing what. */
  onOpenTenant: (id: TenantId) => void;
  onToast: (title: string, detail?: string, status?: 'success' | 'danger') => void;
}

const num = (n: number) => n.toLocaleString();

export function Meters({ api, tenants, onOpenTenant, onToast }: MetersProps) {
  const [reading, setReading] = useState<MeterReading | null>(null);
  const [usage, setUsage] = useState<ModelUsageSummary | null>(null);
  const [busy, setBusy] = useState(false);

  const read = useCallback(
    (announce: boolean) => {
      setBusy(true);
      api
        .readMeters()
        .then((r) => {
          setReading(r);
          if (announce) onToast('Meters re-read', new Date(r.readAt).toLocaleTimeString());
        })
        .catch((e: Error) => onToast('Failed to read meters', e.message, 'danger'))
        .finally(() => setBusy(false));
      api
        .readModelUsage()
        .then(setUsage)
        .catch((e: Error) => onToast('Failed to read model usage', e.message, 'danger'));
    },
    [api, onToast],
  );

  useEffect(() => read(false), [read]);

  const skuColumns: TableColumn<EntitlementMeterRow>[] = [
    { header: 'SKU', key: 'entitlementKey', mono: true },
    {
      header: 'Tier',
      render: (r) =>
        r.plan ? <Tag>{r.plan}</Tag> : <span style={{ color: 'var(--text-tertiary)' }}>ungrouped flag</span>,
    },
    { header: 'Tenants', align: 'right', render: (r) => num(r.tenants) },
    {
      header: 'Lapsed',
      align: 'right',
      // Not billed, but shown beside what is: a lapsed grant is a renewal to chase,
      // and its absence from the billable column is the point.
      render: (r) =>
        r.expired === 0 ? (
          <span style={{ color: 'var(--text-tertiary)' }}>—</span>
        ) : (
          <Badge status="warning">{num(r.expired)}</Badge>
        ),
    },
  ];

  const tenantColumns: TableColumn<TenantMeterRow>[] = [
    {
      header: 'Tenant',
      render: (r) => (
        <span style={{ fontWeight: 500 }}>{tenants.get(r.tenantId)?.name ?? r.slug}</span>
      ),
    },
    { header: 'Slug', key: 'slug', mono: true, muted: true },
    {
      header: 'Status',
      render: (r) => (
        <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
          <Badge status={tenantTone(r.status)}>{r.status[0]!.toUpperCase() + r.status.slice(1)}</Badge>
          {!r.billable && <span style={{ fontSize: 12, color: 'var(--text-tertiary)' }}>not billable</span>}
        </span>
      ),
    },
    {
      header: 'Active scopes',
      align: 'right',
      // The billable number. A cascade-suspended scope lands in the column beside it,
      // which is exactly the disagreement with stored status that makes this a meter.
      render: (r) => <span style={{ fontWeight: 600 }}>{num(r.scopes.active)}</span>,
    },
    {
      header: 'Not serving',
      align: 'right',
      render: (r) => {
        const idle = r.scopes.suspended + r.scopes.provisioning + r.scopes.archived + r.scopes.reaped;
        return idle === 0 ? (
          <span style={{ color: 'var(--text-tertiary)' }}>—</span>
        ) : (
          <span title={`${r.scopes.suspended} suspended · ${r.scopes.provisioning} provisioning · ${r.scopes.archived} archived · ${r.scopes.reaped} reaped`}>
            {num(idle)}
          </span>
        );
      },
    },
    {
      header: 'SKUs',
      align: 'right',
      render: (r) => (
        <span>
          {num(r.entitlements.live)}
          {r.entitlements.expired > 0 && (
            <span style={{ color: 'var(--text-tertiary)' }}> · {num(r.entitlements.expired)} lapsed</span>
          )}
        </span>
      ),
    },
  ];

  const usd = (s: string) => `$${s}`;
  const usageColumns: TableColumn<ModelUsageSummaryRow>[] = [
    {
      header: 'Tenant',
      render: (r) => <span style={{ fontWeight: 500 }}>{tenants.get(r.tenantId)?.name ?? r.tenantId}</span>,
    },
    { header: 'Vertical', key: 'vertical', mono: true, muted: true },
    { header: 'Model', key: 'model', mono: true },
    { header: 'Calls', align: 'right', render: (r) => num(r.calls) },
    {
      header: 'Tokens in / out',
      align: 'right',
      render: (r) => (
        <span title={`${num(r.cachedInputTokens)} cached reads · ${num(r.cacheWriteTokens)} cache writes`}>
          {num(r.inputTokens)} / {num(r.outputTokens)}
        </span>
      ),
    },
    { header: 'List', align: 'right', render: (r) => <span style={{ fontFamily: 'var(--font-mono)' }}>{usd(r.listUsd)}</span> },
    {
      header: 'Billed',
      align: 'right',
      render: (r) => <span style={{ fontWeight: 600, fontFamily: 'var(--font-mono)' }}>{usd(r.billedUsd)}</span>,
    },
    {
      header: 'Unpriced',
      align: 'right',
      // A model the rate card does not know: counted beside the money, never folded in as $0.
      render: (r) =>
        r.unpriced === 0 ? <span style={{ color: 'var(--text-tertiary)' }}>—</span> : <Badge status="warning">{num(r.unpriced)}</Badge>,
    },
  ];

  const scopes = reading?.scopes;
  const skuTotal = reading?.entitlements.reduce((n, r) => n + r.tenants, 0) ?? 0;

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
      <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: 16 }}>
        <div>
          <h2 style={{ margin: 0, fontSize: 20, fontWeight: 600, letterSpacing: '-0.02em' }}>Meters</h2>
          <p style={{ margin: '4px 0 0', fontSize: 13, color: 'var(--text-secondary)' }}>
            The three meters the directory can answer, read live. Nothing here is invoiced —
            a reading is recomputed per visit and stamped with the instant it was taken.
          </p>
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
          {reading && (
            <span style={{ fontSize: 12, color: 'var(--text-tertiary)', fontFamily: 'var(--font-mono)' }}>
              read at {new Date(reading.readAt).toLocaleString()}
            </span>
          )}
          <Button onClick={() => read(true)} disabled={busy}>
            {busy ? 'Reading…' : 'Re-read'}
          </Button>
        </div>
      </div>

      {/* Meter 1 — a COUNT over the directory, per §5 "free; ship it as a number". */}
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: 12 }}>
        <Stat
          label="Active tenants"
          value={num(reading?.tenants.active ?? 0)}
          meta={`of ${num(reading?.tenants.total ?? 0)} in the directory`}
        />
        <Stat
          label="Active scopes"
          value={num(scopes?.active ?? 0)}
          meta={`of ${num(scopes?.total ?? 0)} · the per-scope base fee's multiplier`}
        />
        <Stat
          label="Not serving"
          value={num((scopes?.suspended ?? 0) + (scopes?.archived ?? 0) + (scopes?.provisioning ?? 0))}
          meta={`${num(scopes?.suspended ?? 0)} suspended · ${num(scopes?.archived ?? 0)} archived · ${num(scopes?.provisioning ?? 0)} provisioning`}
        />
        {/* Grants, not SKUs: the sum of billable holders across the rows below, so one
            tenant on two engines counts twice. That IS the licensing unit — naming it
            "SKUs" would read as the catalogue size, which is a different number. */}
        <Stat
          label="Billable grants"
          value={num(skuTotal)}
          meta={`across ${num(reading?.entitlements.length ?? 0)} SKU/tier combinations`}
        />
      </div>

      {/* Meter 2 — entitlement flags ARE the SKUs (master-plan §9). */}
      <Card
        title="Per-engine licensing (meter 2)"
        description="Entitlement flags are the SKUs, grouped by tier. Counts billable holders only — a grant held by a suspended tenant is not revenue."
        padding={0}
      >
        <Table
          columns={skuColumns}
          rows={reading?.entitlements ?? []}
          emptyText="No entitlements granted anywhere in the fleet."
        />
      </Card>

      {/* Meter 3 (#1054) — model usage: list from the rate card, billed = list × the platform's margin, at read time. */}
      <Card
        title={`Model usage (meter 3)${usage ? ` · ${usage.marginPercent}% over list` : ''}`}
        description={
          usage
            ? `Since ${new Date(usage.since).toLocaleDateString()} — ${num(usage.totals.calls)} calls, ${num(usage.totals.inputTokens)} tokens in, ${num(usage.totals.outputTokens)} out · list ${usd(usage.totals.listUsd)} · billed ${usd(usage.totals.billedUsd)}${usage.totals.unpriced ? ` · ${num(usage.totals.unpriced)} unpriced` : ''}. Reads emit nothing, so meter 4 stays absent.`
            : 'Model calls made through the platform’s model host, folded per tenant and model. Reading…'
        }
        padding={0}
      >
        <Table
          columns={usageColumns}
          rows={usage?.rows ?? []}
          emptyText="No model usage recorded this month — no vertical has answered through the platform’s model host yet."
        />
      </Card>

      {/* Meter 1, per tenant — the base fee is per tenant AND per active scope. */}
      <Card
        title="Per tenant (meter 1)"
        description="A scope counts as active only when its tenant is active too: suspending a tenant leaves every scope row untouched while serving nobody, and a meter that read stored status would bill an outage."
        padding={0}
      >
        <Table
          columns={tenantColumns}
          rows={reading?.perTenant ?? []}
          onRowClick={(r) => onOpenTenant(r.tenantId)}
          emptyText="No tenants yet."
        />
      </Card>

      <Card
        title="What meter 3 still cannot count, and why meter 4 is not shown"
        description="Not unbuilt — uncomputable, by construction. Writing it here so it stops being re-proposed."
      >
        <ul style={{ margin: 0, paddingLeft: 18, fontSize: 13, color: 'var(--text-secondary)', lineHeight: 1.7 }}>
          <li>
            <strong>Meter 3 beyond model usage (events retained, storage, API calls).</strong> Model
            calls fan in because each one is raised as a platform intent and drained here; nothing
            else does. The outbox is one table per scope database, queryable only from inside that
            scope — there is no cross-tenant aggregate path and no Tier-2 sink to fan into. Reads emit
            nothing at all, so API volume is unmeterable from the event spine by design, not by omission.
          </li>
          <li>
            <strong>Meter 4 (network transactions).</strong> Needs the cross-tenant order flow, which
            does not exist yet.
          </li>
        </ul>
        <p style={{ margin: '12px 0 0', fontSize: 13, color: 'var(--text-tertiary)' }}>
          A meter you cannot compute is not a pricing decision, it is a data-pipeline project.
        </p>
      </Card>
    </div>
  );
}
