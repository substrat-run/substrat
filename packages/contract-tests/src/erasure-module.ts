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
    case 'async':
      return Promise.resolve() as unknown as void;
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
