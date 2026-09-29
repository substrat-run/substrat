import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { platformActorId, type ScopeDumpTable } from '@substrat-run/contracts';
import { directoryRestoreSuite } from '@substrat-run/contract-tests';
import { SqliteScopeHost } from '../src/index.js';

/**
 * #1912 on the pure adapter: `restoreDirectory` builds every directory table from this code's
 * schema and takes only the dump's rows. Each case gets a host over a directory file of its own,
 * and reads that file through its own connection, so an export's access-log row never enters a
 * comparison.
 */
const staff = platformActorId.parse('01JZ00000000000000000000ST');

directoryRestoreSuite('adapter-sqlite', {
  open: async () => {
    const dir = mkdtempSync(join(tmpdir(), 'directory-restore-tables-'));
    const host = new SqliteScopeHost({ dir });
    return {
      snapshot: async (): Promise<ScopeDumpTable[]> => {
        const db = new Database(join(dir, '_directory.sqlite'), { readonly: true });
        try {
          const defs = db
            .prepare(`SELECT name, sql FROM sqlite_master WHERE type = 'table' AND name NOT GLOB 'sqlite_*' AND sql IS NOT NULL ORDER BY name`)
            .all() as { name: string; sql: string }[];
          return defs.map(({ name, sql }) => {
            const stmt = db.prepare(`SELECT * FROM "${name}"`).raw(true);
            return { name, ddl: sql, columns: stmt.columns().map((c) => c.name), rows: stmt.all() as unknown[][] };
          });
        } finally {
          db.close();
        }
      },
      restore: (tables) => host.admin.restoreDirectory(staff, { capturedAt: '2026-09-29T00:00:00.000Z', tables }),
      registerVertical: (slug) => host.admin.registerVertical(staff, { slug, name: slug, source: 'builtin' }),
      // The restore runs #1764's split itself, before it returns.
      settle: async () => {},
      close: async () => {
        await host.close();
        rmSync(dir, { recursive: true, force: true });
      },
    };
  },
});
