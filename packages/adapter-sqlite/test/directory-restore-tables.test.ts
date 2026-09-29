import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { platformActorId } from '@substrat-run/contracts';
import { directoryRestoreSuite } from '@substrat-run/contract-tests';
import { SqliteScopeHost } from '../src/index.js';
import { readDirectoryFile } from './directory-file.js';

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
      snapshot: async () => readDirectoryFile(dir),
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
