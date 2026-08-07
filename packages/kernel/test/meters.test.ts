import { describe, expect, it } from 'vitest';
import type { Instant, TenantId } from '@substrat-run/contracts';
import { foldMeterReading, type MeterInput } from '../src/meters.js';

/**
 * §5's two computable meters, held to the rules that make them *commercial* numbers
 * rather than row counts (#38). The contract suite pins them through a real adapter;
 * this pins the arithmetic itself, including the cases a fixture is clumsy at building
 * — an orphan scope row, a tenant reaped mid-life, two tiers of one SKU.
 */

const READ_AT = '2026-08-07T09:00:00.000Z' as Instant;
const t = (n: number) => `01J${String(n).padStart(23, '0')}` as TenantId;

const fold = (over: Partial<MeterInput>) =>
  foldMeterReading({ readAt: READ_AT, tenants: [], scopes: [], entitlements: [], ...over });

describe('foldMeterReading', () => {
  it('counts an active scope only when its tenant is active too', () => {
    const r = fold({
      tenants: [
        { tenantId: t(1), slug: 'live', status: 'active' },
        { tenantId: t(2), slug: 'out', status: 'suspended' },
        { tenantId: t(3), slug: 'going', status: 'deleting' },
      ],
      scopes: [
        { tenantId: t(1), status: 'active' },
        { tenantId: t(2), status: 'active' }, // stored active, cascade-suspended
        { tenantId: t(3), status: 'active' }, // deleting is inert too (§4.8)
      ],
    });
    expect(r.scopes).toEqual({ total: 3, active: 1, suspended: 2, provisioning: 0, archived: 0, reaped: 0 });
    expect(r.tenants).toEqual({ total: 3, active: 1, suspended: 1, deleting: 1, reaped: 0 });
    expect(r.perTenant.map((p) => p.billable)).toEqual([true, false, false]);
  });

  it('buckets every scope status, and total reconciles', () => {
    const r = fold({
      tenants: [{ tenantId: t(1), slug: 'a', status: 'active' }],
      scopes: (['provisioning', 'active', 'suspended', 'archiving', 'archived', 'reaped'] as const).map((status) => ({
        tenantId: t(1),
        status,
      })),
    });
    // `archiving` folds under archived — both are reversible and neither serves.
    expect(r.scopes).toEqual({ total: 6, active: 1, suspended: 1, provisioning: 1, archived: 2, reaped: 1 });
    const { total, ...buckets } = r.scopes;
    expect(Object.values(buckets).reduce((a, b) => a + b, 0)).toBe(total);
  });

  it('groups meter 2 by SKU and tier, and never counts a lapsed grant as revenue', () => {
    const r = fold({
      tenants: [
        { tenantId: t(1), slug: 'a', status: 'active' },
        { tenantId: t(2), slug: 'b', status: 'active' },
      ],
      entitlements: [
        { tenantId: t(1), entitlementKey: 'workorder', plan: 'pro', expiresAt: null },
        { tenantId: t(2), entitlementKey: 'workorder', plan: 'pro', expiresAt: '2026-09-01T00:00:00.000Z' },
        { tenantId: t(2), entitlementKey: 'workorder', plan: 'lite', expiresAt: null },
        // Lapsed one hour before the reading: visible as a renewal, billed as nothing.
        { tenantId: t(1), entitlementKey: 'invoicing', plan: null, expiresAt: '2026-08-07T08:00:00.000Z' },
      ],
    });
    expect(r.entitlements).toEqual([
      { entitlementKey: 'invoicing', plan: null, tenants: 0, expired: 1 },
      { entitlementKey: 'workorder', plan: 'lite', tenants: 1, expired: 0 },
      { entitlementKey: 'workorder', plan: 'pro', tenants: 2, expired: 0 },
    ]);
    expect(r.perTenant.find((p) => p.tenantId === t(1))!.entitlements).toEqual({ live: 1, expired: 1 });
  });

  it('drops a non-billable tenant from meter 2 while its per-tenant row still shows the grant', () => {
    const r = fold({
      tenants: [{ tenantId: t(1), slug: 'paused', status: 'suspended' }],
      entitlements: [{ tenantId: t(1), entitlementKey: 'workorder', plan: 'pro', expiresAt: null }],
    });
    // The grant is still HELD — suspension does not revoke — but a suspended tenant is
    // not revenue, and a meter 2 that disagreed with meter 1 would be worse than absent.
    expect(r.entitlements).toEqual([]);
    expect(r.perTenant[0]!.entitlements).toEqual({ live: 1, expired: 0 });
  });

  it('ignores rows whose tenant is not in the reading — the narrowing rule', () => {
    // What a `{ tenantId }`-narrowed read looks like when the caller narrows only the
    // tenant set: everything else must follow, never leak the rest of the fleet in.
    const r = fold({
      tenants: [{ tenantId: t(1), slug: 'mine', status: 'active' }],
      scopes: [
        { tenantId: t(1), status: 'active' },
        { tenantId: t(9), status: 'active' },
      ],
      entitlements: [{ tenantId: t(9), entitlementKey: 'workorder', plan: null, expiresAt: null }],
    });
    expect(r.scopes.total).toBe(1);
    expect(r.entitlements).toEqual([]);
    expect(r.perTenant).toHaveLength(1);
  });

  it('fails closed on an orphan scope — no tenant row means no billing', () => {
    const r = fold({
      tenants: [{ tenantId: t(1), slug: 'a', status: 'active' }],
      scopes: [{ tenantId: t(1), status: 'active' }],
    });
    expect(r.scopes.active).toBe(1);
    // Same rows, but the tenant is a reaped tombstone: the scope stops being billable
    // without anyone having touched the scope row.
    const reaped = fold({
      tenants: [{ tenantId: t(1), slug: 'a', status: 'reaped' }],
      scopes: [{ tenantId: t(1), status: 'active' }],
    });
    expect(reaped.scopes).toMatchObject({ total: 1, active: 0, suspended: 1 });
    expect(reaped.tenants.reaped).toBe(1);
  });

  it('orders per-tenant rows by id and totals them into the fleet numbers', () => {
    const r = fold({
      tenants: [
        { tenantId: t(3), slug: 'c', status: 'active' },
        { tenantId: t(1), slug: 'a', status: 'active' },
        { tenantId: t(2), slug: 'b', status: 'active' },
      ],
      scopes: [t(1), t(2), t(2), t(3)].map((tenantId) => ({ tenantId, status: 'active' as const })),
    });
    expect(r.perTenant.map((p) => p.slug)).toEqual(['a', 'b', 'c']);
    expect(r.scopes.active).toBe(4);
    expect(r.scopes.active).toBe(r.perTenant.reduce((n, p) => n + p.scopes.active, 0));
    expect(r.readAt).toBe(READ_AT);
  });

  it('is a reading of an instant: an empty directory meters zero, not nothing', () => {
    const r = fold({});
    expect(r.tenants).toEqual({ total: 0, active: 0, suspended: 0, deleting: 0, reaped: 0 });
    expect(r.scopes.total).toBe(0);
    expect(r.entitlements).toEqual([]);
    expect(r.perTenant).toEqual([]);
    expect(r.readAt).toBe(READ_AT);
  });
});
