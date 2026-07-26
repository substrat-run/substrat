import { describe, expect, it } from 'vitest';
import type { MigrationFailure, Scope, ScopeStatus } from '@substrat-run/contracts';
import {
  migrationFleet,
  migrationProgress,
  migrationSummary,
  scopeMigrationState,
} from '../src/migration-progress.js';

/**
 * The §5.3 progress computation, held to its shape: "release N: X/Y migrated,
 * P pending, F failed" from directory rows alone. Shared by the sweep report
 * and the control-plane view — which is why it gets its own contract here.
 */

let n = 0;
const genId = () => '01J' + String(++n).padStart(23, '0');

function scopeRow(over: Partial<Scope> & { schemaVersion?: string }): Scope {
  const id = genId();
  return {
    id,
    tenantId: genId(),
    parentScopeId: null,
    slug: `s-${id.toLowerCase()}`,
    kind: 'scope',
    name: 'S',
    status: 'active' as ScopeStatus,
    storageShape: 'A',
    jurisdiction: 'global',
    vertical: null,
    verticalVersionId: null,
    schemaVersion: '3',
    migrationFailure: null,
    forkedFrom: null,
    forkedAt: null,
    expiresAt: null,
    createdAt: '2026-01-01T00:00:00.000Z',
    ...over,
  } as Scope;
}

const failure = (attempts: number): MigrationFailure =>
  ({
    version: '@v/mod@0004-broken',
    error: 'no such column: x',
    attempts,
    lastAttemptAt: '2026-01-01T00:00:00.000Z',
  }) as MigrationFailure;

describe('scopeMigrationState', () => {
  const frontier = { total: 3 };
  it('at or past the frontier is migrated', () => {
    expect(scopeMigrationState(scopeRow({ schemaVersion: '3' }), frontier)).toBe('migrated');
    expect(scopeMigrationState(scopeRow({ schemaVersion: '5' }), frontier)).toBe('migrated');
  });
  it('behind with no failure record is pending — the never-woken straggler', () => {
    expect(scopeMigrationState(scopeRow({ schemaVersion: '2' }), frontier)).toBe('pending');
    expect(scopeMigrationState(scopeRow({ schemaVersion: '0' }), frontier)).toBe('pending');
  });
  it('a recorded failure wins regardless of the count that landed', () => {
    expect(
      scopeMigrationState(scopeRow({ schemaVersion: '2', migrationFailure: failure(1) }), frontier),
    ).toBe('failed');
  });
});

describe('migrationFleet', () => {
  it('keeps live primaries, drops suspended/archived and forks', () => {
    const active = scopeRow({});
    const provisioning = scopeRow({ status: 'provisioning' });
    const suspended = scopeRow({ status: 'suspended' });
    const archived = scopeRow({ status: 'archived' });
    const fork = scopeRow({ forkedFrom: active.id });
    expect(migrationFleet([active, provisioning, suspended, archived, fork])).toEqual([
      active,
      provisioning,
    ]);
  });
});

describe('migrationProgress', () => {
  it('produces the §5.3 numbers and the summary line', () => {
    const scopes = [
      ...Array.from({ length: 4 }, () => scopeRow({ schemaVersion: '3' })),
      scopeRow({ schemaVersion: '1' }), // pending
      scopeRow({ schemaVersion: '2', migrationFailure: failure(2) }), // failed
    ];
    const p = migrationProgress({ total: 3 }, scopes);
    expect(p.release).toBe('3');
    expect(p.total).toBe(6);
    expect(p.migrated).toBe(4);
    expect(p.pending).toBe(1);
    expect(p.failed).toBe(1);
    expect(p.complete).toBe(false);
    expect(p.summary).toBe('release 3: 4/6 migrated, 1 pending, 1 failed');
  });

  it('closes the skew window only when every live primary is at the frontier', () => {
    const done = migrationProgress({ total: 2 }, [scopeRow({ schemaVersion: '2' })]);
    expect(done.complete).toBe(true);
    // A fork behind the frontier does not hold the window open — it is not fleet.
    const withFork = migrationProgress({ total: 2 }, [
      scopeRow({ schemaVersion: '2' }),
      scopeRow({ schemaVersion: '0', forkedFrom: genId() as Scope['id'] }),
    ]);
    expect(withFork.complete).toBe(true);
  });

  it('lists failed stragglers first and flags past the threshold', () => {
    const pendingScope = scopeRow({ schemaVersion: '0' });
    const flaggedScope = scopeRow({ schemaVersion: '1', migrationFailure: failure(3) });
    const freshFail = scopeRow({ schemaVersion: '1', migrationFailure: failure(1) });
    const p = migrationProgress({ total: 2 }, [pendingScope, flaggedScope, freshFail]);
    expect(p.stragglers.map((s) => s.state)).toEqual(['failed', 'failed', 'pending']);
    const flagged = p.stragglers.find((s) => s.scopeId === flaggedScope.id);
    expect(flagged?.flagged).toBe(true);
    expect(p.stragglers.find((s) => s.scopeId === freshFail.id)?.flagged).toBe(false);
    expect(p.stragglers.find((s) => s.scopeId === pendingScope.id)?.flagged).toBe(false);
  });

  it('caps the straggler list while the counts stay whole', () => {
    const scopes = Array.from({ length: 60 }, () => scopeRow({ schemaVersion: '0' }));
    const p = migrationProgress({ total: 1 }, scopes);
    expect(p.pending).toBe(60);
    expect(p.stragglers).toHaveLength(50);
  });

  it('honors a custom flag threshold', () => {
    const s = scopeRow({ schemaVersion: '0', migrationFailure: failure(1) });
    expect(
      migrationProgress({ total: 1 }, [s], { flagThreshold: 1 }).stragglers[0]!.flagged,
    ).toBe(true);
  });
});

describe('migrationSummary', () => {
  it('renders the exact §5.3 shape', () => {
    expect(
      migrationSummary({ release: '42', total: 500, migrated: 487, pending: 13, failed: 0 }),
    ).toBe('release 42: 487/500 migrated, 13 pending, 0 failed');
  });
});
