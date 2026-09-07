/**
 * A tiny custom module — the "write your own" half of a vertical.
 *
 * It follows every module rule the platform enforces mechanically: data access
 * is `ctx.sql` only, the permission check is the operation's first line, the
 * clock is `ctx.now()`, inputs are parsed by the HOST (`operationInputs`) rather
 * than by each handler, list reads return a PAGE, and every mutation emits a
 * kernel-stamped event. Nothing here imports a database driver, a node built-in,
 * or another module — it is the same shape an engine ships, just smaller. It
 * runs unchanged on the SQLite adapter (local) and the Cloudflare adapter
 * (deployed).
 */
import {
  listLimitOf,
  moduleManifest,
  pageOf,
  permissionKey,
  z,
  type Page,
} from '@substrat-run/contracts';
import {
  assertAllowed,
  ulid,
  type ModuleRegistration,
  type OperationHandler,
} from '@substrat-run/kernel';

export const NOTES_PERM = {
  write: permissionKey.parse('notes:write'),
  read: permissionKey.parse('notes:read'),
};

const noteInput = z.object({ text: z.string().min(1) });

/** A paged read takes the walk's parameters, and nothing else here narrows. */
const noteListInput = z.object({
  limit: z.coerce.number().int().positive().optional(),
  cursor: z.string().min(1).optional(),
});

interface NoteRow {
  id: string;
  text: string;
  created_by: string;
  created_at: string;
}

const createOp: OperationHandler<z.infer<typeof noteInput>, { id: string }> = async (ctx, input) => {
  assertAllowed(await ctx.check(NOTES_PERM.write));
  const id = ulid();
  // `ctx.now()` is the only clock module code may read, and it is stable for the
  // whole invocation — so the row and the event announcing it cannot disagree
  // about when. `new Date()` here is a boundary-lint R6 violation.
  ctx.sql.exec('INSERT INTO notes (id, text, created_by, created_at) VALUES (?, ?, ?, ?)', [
    id,
    input.text,
    ctx.principal,
    ctx.now(),
  ]);
  // No origin fields: tenant, scope, actor, id and timestamp are stamped by
  // the kernel, so this event physically cannot be mislabelled.
  ctx.emit({
    type: 'notes.created',
    schemaVersion: 1,
    entity: { entityType: 'note', entityId: id },
    piiClass: 'none',
    payload: { noteId: id },
  });
  return { id };
};

/**
 * A list read returns a keyset PAGE, never the whole table (#811): the handler
 * owns its `SELECT`, so it takes the page off the result with `pageOf`. The
 * cursor is the last entry's sort key verbatim — here the ULID `id`, walked
 * newest-first, so it is also chronological.
 */
const listOp: OperationHandler<z.infer<typeof noteListInput>, Page<NoteRow>> = async (
  ctx,
  input,
) => {
  assertAllowed(await ctx.check(NOTES_PERM.read));
  // `listLimitOf` defaults and caps the page, so an in-process caller that asked
  // for nothing gets exactly the page an HTTP caller would.
  const limit = listLimitOf(input.limit);
  const cursor = input.cursor;
  const rows = ctx.sql.query<NoteRow>(
    `SELECT id, text, created_by, created_at FROM notes
      ${cursor === undefined ? '' : 'WHERE id < ?'}
      ORDER BY id DESC LIMIT ?`,
    cursor === undefined ? [limit] : [cursor, limit],
  );
  return pageOf(rows, limit, (row) => row.id);
};

export const notesModule: ModuleRegistration = {
  manifest: moduleManifest.parse({
    id: '@acme/notes',
    version: '0.0.1',
    kernelContract: '^0.0.1',
    permissions: [
      { key: 'notes:write', description: 'Create notes' },
      { key: 'notes:read', description: 'Read notes' },
    ],
    events: {
      emits: [{ type: 'notes.created', schemaVersion: 1 }],
      consumes: [],
    },
    migrations: { journalDir: './migrations', compatibleFrom: '0.0.1' },
    attachmentTargets: [],
    // The SKU flag that gates loading (D-20): a tenant without this entitlement
    // loads none of these operations.
    entitlementKey: 'notes',
  }),
  migrations: [
    {
      version: '0001-init',
      sql: `CREATE TABLE notes (
        id         TEXT PRIMARY KEY,
        text       TEXT NOT NULL,
        created_by TEXT NOT NULL,
        created_at TEXT NOT NULL
      );`,
    },
  ],
  // "Parse, don't trust", kept in ONE place rather than in each handler: the host
  // parses an invocation against these before the guards and the handler see it,
  // on every path in (HTTP, test, seed, schedule).
  operationInputs: {
    'notes/create': noteInput,
    // An in-process caller (a test, a seed, another operation) invokes a list
    // with no body at all, so the empty page is materialised here rather than in
    // the handler — the same thing `operationInputsOf` does for a declared
    // `paged` read.
    'notes/list': z.preprocess((value) => value ?? {}, noteListInput),
  },
  operations: {
    'notes/create': createOp as OperationHandler<never, unknown>,
    'notes/list': listOp as OperationHandler<never, unknown>,
  },
};
