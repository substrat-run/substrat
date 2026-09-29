import { env, runDurableObjectAlarm } from 'cloudflare:test';
import { beforeAll } from 'vitest';
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
