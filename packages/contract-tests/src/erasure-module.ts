/**
 * The fixture behind `subjectErasureContractSuite` (#2068): a module whose entities differ in
 * exactly how an erasure reaches them, declared through `defineEntities` and turned into the
 * manifest by `manifestEntities` — the path a vertical takes — so the suite exercises the
 * derivation as well as the kernel.
 *
 * - `erperson` — blank, keyed by its own id: a nullable field becomes NULL, a NOT NULL one ''.
 * - `ernote` — blank, keyed by a second column (`author`), and SEARCHABLE over its body, so the
 *   suite can see an erased word leave the index and the index's shadow tables.
 * - `ersignup` — delete: its erasable `email` is in its `key`, so a blank would collide.
 * - `errating` — custom: reached only through the note it rates, which the hook follows.
 * - `erloose` — erasable and declaring nothing, so every receipt names it unreached.
 * - `erbomb` — not erasable: the switchboard the suite uses to make the hook misbehave for ONE
 *   subject (throw, read the spine, read another module, run a PRAGMA, return a promise),
 *   so every other subject in every other suite is erased normally.
 *
 * `@test/erasure-other` owns one table and nothing erasable: the "another module" a hook must
 * not reach.
 *
 * Every operation is a thin pass-through and checks nothing itself; the erasure is a staff
 * verb, and the operations exist only to set up and read back the rows it acts on.
 */
import { z } from 'zod';
import { dataSubjectId, defineEntities, manifestEntities, moduleManifest } from '@substrat-run/contracts';
import type { ModuleRegistration, OnSubjectErased, OperationHandler } from '@substrat-run/kernel';

export const erasureEntities = defineEntities({
  erperson: {
    table: 'er_people',
    fields: z.object({ id: z.string(), email: z.string().nullable(), name: z.string() }),
    erasable: ['email', 'name'],
    erasure: { subjects: ['id'] },
  },
  ernote: {
    table: 'er_notes',
    fields: z.object({
      id: z.string(),
      author: z.string().nullable(),
      editor: z.string().nullable(),
      title: z.string().nullable(),
      body: z.string(),
    }),
    erasable: ['title', 'body'],
    erasure: { subjects: ['author', 'editor'] },
  },
  ersignup: {
    table: 'er_signups',
    fields: z.object({ id: z.string(), kind: z.string(), email: z.string() }),
    key: ['kind', 'email'],
    erasable: ['email'],
    erasure: { subjects: ['id'], mode: 'delete' },
  },
  errating: {
    table: 'er_ratings',
    fields: z.object({ note_id: z.string(), comment: z.string().nullable() }),
    primaryKey: ['note_id'],
    erasable: ['comment'],
    erasure: { mode: 'custom' },
  },
  erloose: {
    table: 'er_loose',
    fields: z.object({ id: z.string(), memo: z.string().nullable() }),
    erasable: ['memo'],
  },
  erbomb: {
    table: 'er_bombs',
    fields: z.object({ subject: z.string(), kind: z.string() }),
    primaryKey: ['subject'],
  },
});

export const erasureModManifest = moduleManifest.parse({
  id: '@test/erasure',
  version: '1.0.0',
  kernelContract: '^0.0.1',
  permissions: [],
  events: { emits: [{ type: 'erasure.noted', schemaVersion: 1 }], consumes: [] },
  migrations: { journalDir: './migrations', compatibleFrom: '1.0.0' },
  entitlementKey: 'erasure',
  ...manifestEntities(erasureEntities, {
    searchables: [{ entityType: 'ernote', fields: ['body'] }],
  }),
});

/** The tables `@test/erasure` owns, as its migration creates them. */
const ERASURE_DDL = `
  CREATE TABLE er_people (id TEXT PRIMARY KEY, email TEXT, name TEXT NOT NULL);
  CREATE TABLE er_notes (id TEXT PRIMARY KEY, author TEXT, editor TEXT, title TEXT, body TEXT NOT NULL);
  CREATE TABLE er_signups (id TEXT PRIMARY KEY, kind TEXT NOT NULL, email TEXT NOT NULL, UNIQUE (kind, email));
  CREATE TABLE er_ratings (note_id TEXT PRIMARY KEY, comment TEXT);
  CREATE TABLE er_loose (id TEXT PRIMARY KEY, memo TEXT);
  CREATE TABLE er_bombs (subject TEXT PRIMARY KEY, kind TEXT NOT NULL);
  -- IF NOT EXISTS: the kit's wipe and restore paths replay this migration onto a store whose
  -- tables were dropped and replayed, and a view is not a table they touch.
  CREATE VIEW IF NOT EXISTS er_view AS SELECT id, memo FROM er_loose;
`;

/**
 * The hook: a rating is the subject's when the note it rates was written by them. Idempotent —
 * it touches only ratings still holding a comment — and synchronous, unless `er_bombs` tells it
 * to misbehave for this subject.
 */
const onSubjectErased: OnSubjectErased = (ctx, { subjectId }) => {
  const bomb = ctx.sql.query<{ kind: string }>('SELECT kind FROM er_bombs WHERE subject = ?', [subjectId])[0];
  // Looks before it writes: a hook's write makes the kernel switch the module's search indexes
  // to secure-delete for the erasure, which an erasure holding nothing here need not do.
  const held = ctx.sql.query<{ note_id: string }>(
    `SELECT note_id FROM er_ratings
      WHERE comment IS NOT NULL AND note_id IN (SELECT id FROM er_notes WHERE author = ?)`,
    [subjectId],
  );
  if (held.length > 0) {
    ctx.sql.exec(
      `UPDATE er_ratings SET comment = NULL
        WHERE comment IS NOT NULL AND note_id IN (SELECT id FROM er_notes WHERE author = ?)`,
      [subjectId],
    );
  }
  switch (bomb?.kind) {
    case 'throw':
      throw new Error('the hook failed half-way');
    case 'spine':
      ctx.sql.query('SELECT payload FROM _substrat_outbox');
      break;
    case 'foreign':
      ctx.sql.query('SELECT * FROM er_other');
      break;
    case 'pragma':
      ctx.sql.query('PRAGMA table_info(er_notes)');
      break;
    case 'chained':
      ctx.sql.exec('UPDATE er_loose SET memo = NULL WHERE id = ?; DELETE FROM er_other', [subjectId]);
      break;
    case 'view':
      // A view the module's own migration created is still not one of its tables.
      ctx.sql.query('SELECT memo FROM er_view');
      break;
    case 'cte':
      ctx.sql.query('WITH er_notes AS (SELECT secret AS body FROM er_other) SELECT body FROM er_notes');
      break;
    case 'comma':
      ctx.sql.query('SELECT * FROM (SELECT 1 AS one) AS a, er_other');
      break;
    case 'async':
      return Promise.resolve() as unknown as void;
    case 'async-write':
      // Refused for returning a promise; its continuation then tries to write anyway.
      return (async () => {
        await Promise.resolve();
        ctx.sql.exec("UPDATE er_loose SET memo = 'written after the erasure' WHERE id = ?", [subjectId]);
      })() as unknown as void;
    case 'stash':
      // Keeps the handle where a later operation can reach it.
      (globalThis as { __erasureStash?: unknown }).__erasureStash = ctx.sql;
      break;
  }
};

type Handler = OperationHandler<never, unknown>;

export const erasureMod: ModuleRegistration = {
  manifest: erasureModManifest,
  migrations: [{ version: '0001-init', sql: ERASURE_DDL }],
  operations: {
    /** Write a fixture row: `{ sql, params }` against the module's own tables. */
    'erasure/put': ((ctx, input: { sql: string; params?: (string | null)[] }) => {
      ctx.sql.exec(input.sql, input.params ?? []);
    }) as Handler,
    /** Read rows back: `{ sql, params }`. */
    'erasure/read': ((ctx, input: { sql: string; params?: (string | null)[] }) =>
      ctx.sql.query(input.sql, input.params ?? [])) as Handler,
    'erasure/search': ((ctx, input: { term: string }) => ctx.search('ernote', input.term)) as Handler,
    /** Use a hook's `ctx.sql` that a hook stashed on a global, after its erasure finished. */
    'erasure/use-stash': ((_ctx, input: { subject: string }) => {
      const stash = (globalThis as { __erasureStash?: { exec(sql: string, params: unknown[]): unknown } }).__erasureStash;
      if (!stash) throw new Error('nothing stashed');
      stash.exec("UPDATE er_loose SET memo = 'written through a stashed handle' WHERE id = ?", [input.subject]);
    }) as Handler,
    /** A classified event about the subject, so the spine half of a rolled-back erasure is visible. */
    'erasure/emit': ((ctx, input: { subject: string; secret: string }) => {
      ctx.emit({
        type: 'erasure.noted',
        schemaVersion: 1,
        entity: { entityType: 'erperson', entityId: input.subject },
        piiClass: 'pseudonymous',
        subjectId: dataSubjectId.parse(input.subject),
        payload: { secret: input.secret },
      });
    }) as Handler,
  },
  onSubjectErased,
};

export const erasureOtherMod: ModuleRegistration = {
  manifest: moduleManifest.parse({
    id: '@test/erasure-other',
    version: '1.0.0',
    kernelContract: '^0.0.1',
    permissions: [],
    events: { emits: [], consumes: [] },
    migrations: { journalDir: './migrations', compatibleFrom: '1.0.0' },
    attachmentTargets: [],
    entitlementKey: 'erasure-other',
  }),
  migrations: [{ version: '0001-init', sql: 'CREATE TABLE er_other (id TEXT PRIMARY KEY, secret TEXT);' }],
};

/**
 * A module whose model claims a table its migrations never create — `er_other`, which belongs
 * to `@test/erasure-other`. Registering it must be refused: its declared blank would otherwise
 * run against another module's rows through the kernel's own handle.
 */
export const erasureMisdeclaredMod: ModuleRegistration = {
  manifest: moduleManifest.parse({
    id: '@test/erasure-misdeclared',
    version: '1.0.0',
    kernelContract: '^0.0.1',
    permissions: [],
    events: { emits: [], consumes: [] },
    migrations: { journalDir: './migrations', compatibleFrom: '1.0.0' },
    entitlementKey: 'erasure-misdeclared',
    ...manifestEntities(
      defineEntities({
        stolen: {
          table: 'er_other',
          fields: z.object({ id: z.string(), secret: z.string().nullable() }),
          erasable: ['secret'],
          erasure: { subjects: ['id'] },
        },
      }),
      {},
    ),
  }),
  migrations: [{ version: '0001-init', sql: 'CREATE TABLE er_misdeclared_own (id TEXT PRIMARY KEY);' }],
};

/**
 * A module whose migration says `CREATE TABLE IF NOT EXISTS er_other` — `@test/erasure-other`'s
 * table, which already exists — and whose model then declares an erasure on it. The migration
 * text reads as a creation, so registration lets it through; the scope records nothing for it,
 * and the erasure refuses. Not in `contractTestModules`: on every scope it would refuse every
 * other suite's erasure. `adapter-sqlite/test/erasure-ownership.test.ts` mounts it alone.
 */
export const erasureSquatterMod: ModuleRegistration = {
  manifest: moduleManifest.parse({
    id: '@test/erasure-squatter',
    version: '1.0.0',
    kernelContract: '^0.0.1',
    permissions: [],
    events: { emits: [], consumes: [] },
    migrations: { journalDir: './migrations', compatibleFrom: '1.0.0' },
    entitlementKey: 'erasure-squatter',
    ...manifestEntities(
      defineEntities({
        other: {
          table: 'er_other',
          fields: z.object({ id: z.string(), secret: z.string().nullable() }),
          erasable: ['secret'],
          erasure: { subjects: ['id'] },
        },
      }),
      {},
    ),
  }),
  migrations: [{ version: '0001', sql: 'CREATE TABLE IF NOT EXISTS er_other (id TEXT PRIMARY KEY, secret TEXT);' }],
};
