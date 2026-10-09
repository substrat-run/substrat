import { describe, expect, it } from 'vitest';
import type { Instant, TenantId } from '@substrat-run/contracts';
import { foldMeterReading, type MeterInput } from '../src/meters.js';
import { foldStorageGauge, storageGaugeDay, storageRetentionHorizon } from '../src/storage-gauge.js';

/**
 * The stored storage gauge's arithmetic (#1524). The SQL half (upsert per day, tenant check,
 * retention, reap) is held through both real adapters in the contract suite; this pins the
 * fold, the day a reading belongs to, and where thirteen months ends.
 */

const READ_AT = '2026-08-07T09:00:00.000Z' as Instant;
const t = (n: number) => `01J${String(n).padStart(23, '0')}` as TenantId;
const fold = (over: Partial<MeterInput>) =>
  foldMeterReading({ readAt: READ_AT, tenants: [], scopes: [], entitlements: [], ...over });

describe('storage gauge arithmetic (#1524)', () => {
  it('buckets a reading by its UTC day, whatever offset it was written in', () => {
    expect(storageGaugeDay('2026-03-01T23:59:59.999Z')).toBe('2026-03-01');
    expect(storageGaugeDay('2026-03-02T00:00:00.000Z')).toBe('2026-03-02');
    expect(storageGaugeDay('2026-03-02T00:30:00.000+01:00')).toBe('2026-03-01');
  });

  it('keeps thirteen calendar months, clamping a month end to the shorter month', () => {
    const at = (iso: string) => storageRetentionHorizon(Date.parse(`${iso}T12:00:00Z`));
    expect(at('2026-10-09')).toBe('2025-09-09');
    expect(at('2027-01-31')).toBe('2025-12-31');
    // Month ends whose target month is shorter: never rolled forward into the month after.
    expect(at('2027-03-31')).toBe('2026-02-28');
    expect(at('2025-03-31')).toBe('2024-02-29'); // leap year
    expect(at('2026-12-31')).toBe('2025-11-30');
    expect(at('2027-03-28')).toBe('2026-02-28');
    expect(at('2027-03-01')).toBe('2026-02-01');
  });

  it('sums readings and names its oldest and newest, or nulls when nothing is sampled', () => {
    expect(
      foldStorageGauge(
        [
          { bytes: 100, readAt: '2026-08-06T10:00:00.000Z' },
          { bytes: 50, readAt: '2026-08-05T10:00:00.000Z' },
        ],
        3,
      ),
    ).toEqual({
      basis: 'scope-databases',
      excluded: ['attachments', 'tenant-stores', 'lake'],
      bytes: 150,
      sampled: 2,
      total: 3,
      oldestReadAt: '2026-08-05T10:00:00.000Z',
      newestReadAt: '2026-08-06T10:00:00.000Z',
      failing: 0,
      lastFailedAt: null,
    });
    expect(foldStorageGauge([], 2)).toMatchObject({ bytes: 0, sampled: 0, total: 2, oldestReadAt: null, newestReadAt: null });
  });

  it("folds each tenant's samples into its own row only, and the fleet sum over the reading's tenants", () => {
    const r = fold({
      tenants: [
        { tenantId: t(1), slug: 'a', status: 'active' },
        { tenantId: t(2), slug: 'b', status: 'active' },
      ],
      scopes: [
        { tenantId: t(1), status: 'active' },
        { tenantId: t(1), status: 'reaped' }, // no storage left: not in the denominator
        { tenantId: t(2), status: 'active' },
        { tenantId: t(2), status: 'archived' },
      ],
      storage: [
        { tenantId: t(1), bytes: 1000, readAt: '2026-08-06T00:00:00.000Z' },
        { tenantId: t(2), bytes: 7, readAt: '2026-08-01T00:00:00.000Z' },
        // A tenant outside the reading contributes to nothing.
        { tenantId: t(9), bytes: 999_999, readAt: '2026-08-06T00:00:00.000Z' },
      ],
    });
    expect(r.perTenant.map((p) => [p.slug, p.storage?.bytes, p.storage?.sampled, p.storage?.total])).toEqual([
      ['a', 1000, 1, 1],
      ['b', 7, 1, 2],
    ]);
    expect(r.storage).toMatchObject({
      bytes: 1007,
      sampled: 2,
      total: 3,
      oldestReadAt: '2026-08-01T00:00:00.000Z',
      newestReadAt: '2026-08-06T00:00:00.000Z',
    });
  });

  it("counts each tenant's failing scopes from its own latest attempts, and names the latest failure", () => {
    const r = fold({
      tenants: [
        { tenantId: t(1), slug: 'a', status: 'active' },
        { tenantId: t(2), slug: 'b', status: 'active' },
      ],
      scopes: [
        { tenantId: t(1), status: 'active' },
        { tenantId: t(1), status: 'active' },
        { tenantId: t(2), status: 'active' },
      ],
      storage: [{ tenantId: t(1), bytes: 10, readAt: '2026-08-06T00:00:00.000Z' }],
      storageAttempts: [
        { tenantId: t(1), attemptedAt: '2026-08-06T00:00:00.000Z', error: null },
        { tenantId: t(1), attemptedAt: '2026-08-06T03:00:00.000Z', error: 'vertical answered 501' },
        { tenantId: t(2), attemptedAt: '2026-08-05T03:00:00.000Z', error: 'boom' },
      ],
    });
    expect(r.perTenant.map((p) => [p.slug, p.storage?.failing, p.storage?.lastFailedAt])).toEqual([
      ['a', 1, '2026-08-06T03:00:00.000Z'],
      ['b', 1, '2026-08-05T03:00:00.000Z'],
    ]);
    expect(r.storage).toMatchObject({ failing: 2, lastFailedAt: '2026-08-06T03:00:00.000Z', bytes: 10 });
  });

  it('carries no storage at all from a host that keeps no gauge, rather than a zero', () => {
    const r = fold({ tenants: [{ tenantId: t(1), slug: 'a', status: 'active' }], scopes: [{ tenantId: t(1), status: 'active' }] });
    expect(r.storage).toBeUndefined();
    expect(r.perTenant[0]).not.toHaveProperty('storage');
  });
});
