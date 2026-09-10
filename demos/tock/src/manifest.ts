/**
 * Tock's declarative surface — assembled, not written.
 *
 * Both halves come from `spec/model.ts`: `manifestOperations` reads the permission keys and
 * emitted events off the operations, `manifestEntities` reads the parent edges off the
 * entities. What is left here is what is genuinely a fact about this DEPLOYMENT rather than
 * about the app — its id, its version, where its journal lives.
 *
 * Permission descriptions are prose, so they are supplied rather than derived — but the key
 * SET is checked against what the operations actually require, so a key nobody described is
 * an error rather than an undocumented permission.
 */
import {
  listsDeclaredBy,
  manifestEntities,
  manifestOperations,
  moduleManifest,
  permissionKey,
} from '@substrat-run/contracts';
import { tockEntities, tockOperations } from '../spec/model.js';

export const TOCK_PERM = {
  reportRead: permissionKey.parse('report:read'),
  rowRead: permissionKey.parse('row:read'),
  runManage: permissionKey.parse('run:manage'),
  schemaManage: permissionKey.parse('schema:manage'),
} as const;

export const tockManifest = moduleManifest.parse({
  id: '@substrat-run/demo-tock',
  version: '0.1.0',
  kernelContract: '^0.0.1',
  migrations: { journalDir: './migrations', compatibleFrom: '0.1.0' },
  ...manifestOperations(tockOperations, {
    permissions: {
      'report:read': 'Read counts, schemas, runs and findings',
      'row:read': 'Read the mapped rows of a run, and download the file it came from',
      'run:manage': 'Upload a file and take a run through profiling, mapping and counting',
      'schema:manage': 'Declare a source and write new versions of its shape',
    },
  }),
  /**
   * Nothing is searchable, and that is a decision rather than an omission.
   *
   * The two tables anyone would reach for are the wrong ones. `tock_rows` is the personal-data
   * table — a full-text index over it would be a second copy of the thing `row:read` exists to
   * guard, sitting outside the permission that guards it. And `tock_observations` holds field
   * NAMES, which are already the answer the deviations view returns from a bounded query; an
   * index would be machinery for a screen that has no search box.
   *
   * A source or a schema is found by key, of which a workspace has a handful.
   */
  ...manifestEntities(tockEntities, { searchables: [] }),
  /** Derived from the operations' own `paged.over` — the index the kernel builds and the
   *  vocabulary the read offers are one fact, never written twice. */
  lists: listsDeclaredBy(tockOperations, tockEntities),
  entitlementKey: 'tock',
});
