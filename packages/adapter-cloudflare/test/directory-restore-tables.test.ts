import { env, runDurableObjectAlarm } from 'cloudflare:test';
import { beforeAll, describe, expect, it } from 'vitest';
import type { ScopeDumpTable } from '@substrat-run/contracts';
import { directoryRestoreSuite } from '@substrat-run/contract-tests';
import { ulid } from '@substrat-run/kernel';
import { warmControlPlane } from './do-warmup.js';

/**
 * #1912 on workerd, where the hosted directory lives: `ControlPlaneDO.importDump` builds every
 * directory table from `DIRECTORY_DDL` and takes only the dump's rows.
 *
 * Every case runs on a directory DO of its own (a fresh name, so a namespace entry no other file
 * addresses), read through `exportDump`, which records nothing. A whole-directory comparison can
 * therefore see nothing another file wrote (#1899).
 */
interface Directory {
  exportDump(): Promise<ScopeDumpTable[]>;
  importDump(tables: ScopeDumpTable[]): Promise<void>;
  insertVertical(
    slug: string, name: string, source: string, ownerTenant: string | null,
    envSpec: string | null, installSpec: string | null, listed: number, createdAt: string,
  ): Promise<void>;
}

beforeAll(() => warmControlPlane(env.CONTROL_PLANE));

directoryRestoreSuite('ControlPlaneDO', {
  open: async () => {
    const stub = env.CONTROL_PLANE.get(env.CONTROL_PLANE.idFromName(`restore-tables-${ulid()}`));
    const dir = stub as unknown as Directory;
    return {
      snapshot: () => dir.exportDump(),
      restore: (tables) => dir.importDump(tables),
      // The INSERT the host's `registerVertical` runs, which names no capability column.
      registerVertical: (slug) => dir.insertVertical(slug, slug, 'builtin', null, null, null, 0, '2026-09-29T00:00:00.000Z'),
      // A restore arms #1764's split as an alarm; run it now, and every batch it re-arms.
      settle: async () => {
        while (await runDurableObjectAlarm(stub));
      },
      close: async () => {},
    };
  },
});

/**
 * A Durable Object holds at most 100 columns a table. `assertReplayableDump` holds each dumped
 * column list to that, but a registry grows by this code's columns plus the dump's unknown ones:
 * a `tenants` naming four of its own columns and 96 new ones is 100 in the dump and 103 here.
 */
describe('ControlPlaneDO: a registry the dump would widen past the column cap (#1912)', () => {
  const own = ['tenant_id', 'slug', 'name', 'created_at'];
  const widened = (tables: ScopeDumpTable[], extra: number): ScopeDumpTable[] => {
    const columns = [...own, ...Array.from({ length: extra }, (_, i) => `c${i}`)];
    return tables.map((t) =>
      t.name === 'tenants'
        ? { ...t, ddl: `CREATE TABLE tenants (${columns.join(', ')})`, columns, rows: [columns.map((c) => (c === 'tenant_id' ? 't-1' : c))] }
        : t,
    );
  };

  it('is refused with a sentence, and the directory is left as it was', async () => {
    const dir = env.CONTROL_PLANE.get(env.CONTROL_PLANE.idFromName(`restore-cap-${ulid()}`)) as unknown as Directory;
    const fresh = await dir.exportDump();
    const held = fresh.map((t) => (t.name === 'tenants' ? { ...t, rows: [t.columns.map((c) => ({ tenant_id: 't-0', slug: 'kept', name: 'Kept', status: 'active', created_at: 'c' })[c] ?? null)] } : t));
    await dir.importDump(held);
    const before = await dir.exportDump();
    const ownWidth = before.find((t) => t.name === 'tenants')!.columns.length;
    // At the cap in the dump itself, so `assertReplayableDump` lets it through.
    const extra = 100 - own.length;
    await expect(dir.importDump(widened(before, extra))).rejects.toThrow(new RegExp(`tenants would hold ${ownWidth + extra} columns.*at most 100`));
    expect(await dir.exportDump()).toEqual(before);
  });

  it('twin: exactly at the cap restores', async () => {
    const dir = env.CONTROL_PLANE.get(env.CONTROL_PLANE.idFromName(`restore-cap-${ulid()}`)) as unknown as Directory;
    const fresh = await dir.exportDump();
    const ownWidth = fresh.find((t) => t.name === 'tenants')!.columns.length;
    await dir.importDump(widened(fresh, 100 - ownWidth));
    expect((await dir.exportDump()).find((t) => t.name === 'tenants')!.columns).toHaveLength(100);
  });
});
