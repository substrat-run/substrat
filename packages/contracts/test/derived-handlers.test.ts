/**
 * #1773 — which handlers the platform could write, and the gate that makes a module say so.
 *
 * `derivationOf` is the pure classifier: each shape's positive case, then one negative per
 * clause, each changing exactly one thing about a declaration that otherwise derives — so a
 * clause that stops biting fails here rather than deriving a handler that gets the shape wrong.
 * `defineOperations` is the gate: refusals (a)–(d) by their exact wording, since the remedy is
 * in the message and the message is what a builder reads.
 */
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { entityStateName, entityStateOutput } from '../src/entity-state.js';
import { defineEntities } from '../src/model.js';
import { defineOperations, derivationOf, derivationPlanOf } from '../src/operations.js';

const entities = defineEntities({
  folder: { table: 't_folders', fields: z.object({ id: z.string(), name: z.string() }) },
  note: {
    table: 't_notes',
    fields: z.object({
      id: z.string(),
      folder_id: z.string(),
      title: z.string(),
      body: z.string().nullable(),
      rank: z.number(),
      pinned: z.number(),
      status: z.enum(['draft', 'done']),
    }),
    parents: ['folder'],
  },
  bin: {
    table: 't_bins',
    fields: z.object({ id: z.string(), label: z.string() }),
    trash: { permission: 'note:write' },
  },
  // #119: archivable and trashable, each under its own key.
  shelf: {
    table: 't_shelves',
    fields: z.object({ id: z.string(), label: z.string() }),
    archive: { permission: 'note:archive' },
    trash: { permission: 'note:write' },
  },
  pair: {
    table: 't_pairs',
    fields: z.object({ left: z.string(), right: z.string() }),
    primaryKey: ['left', 'right'],
  },
});
const PERMS = ['note:read', 'note:write', 'note:archive'] as const;
const define = defineOperations(entities, PERMS);
const byNote = z.object({ noteId: z.string() });
const noteRow = { entity: 'note', idFrom: 'noteId' } as const;
const emitsNote = (type: string) =>
  ({ entity: 'note', entityIdFrom: 'id', type, schemaVersion: 1, piiClass: 'none', payload: ['id'] }) as const;

/** Each shape's declaration that derives, as a plain object a negative case can change one thing in. */
const GET = {
  summary: 's',
  permission: { key: 'note:read', ...noteRow },
  input: byNote,
  output: entities.note.fields,
  http: { method: 'GET', path: '/notes/{noteId}' },
} as const;
const LIST = {
  summary: 's',
  permission: { key: 'note:read', entity: 'folder', idFrom: 'folderId' },
  input: z.object({ folderId: z.string(), status: z.enum(['draft', 'done']).optional() }),
  output: entities.note.fields,
  paged: { over: { entity: 'note', sortable: ['rank'], filterable: ['folder_id', 'status', 'pinned'] } },
  http: { method: 'GET', path: '/folders/{folderId}/notes' },
} as const;
const UPDATE = {
  summary: 's',
  permission: { key: 'note:write', ...noteRow },
  input: z.object({ noteId: z.string(), title: z.string().optional(), body: z.string().nullable().optional() }),
  output: entities.note.fields,
  http: { method: 'PATCH', path: '/notes/{noteId}' },
  concurrency: { over: 'note', idFrom: 'noteId' },
  emits: emitsNote('n.updated'),
} as const;
const DELETE = {
  summary: 's',
  permission: { key: 'note:write', ...noteRow },
  input: byNote,
  output: z.object({ id: z.string(), deleted: z.boolean() }),
  http: { method: 'DELETE', path: '/notes/{noteId}' },
  emits: emitsNote('n.deleted'),
} as const;

const kindOf = (decl: object) => derivationOf(decl, entities)?.kind;

describe('derivationOf — get', () => {
  it('derives one row by its id, read through every declared column', () => {
    expect(derivationOf(GET, entities)).toEqual({
      kind: 'get',
      entity: 'note',
      table: 't_notes',
      primaryKey: 'id',
      columns: ['id', 'folder_id', 'title', 'body', 'rank', 'pinned', 'status'],
      permission: { key: 'note:read', entity: 'note', idFrom: 'noteId' },
      idFrom: 'noteId',
    });
    expect(kindOf({ ...GET, permission: 'note:read' })).toBe('get');
  });

  it.each([
    ['served as anything but GET', { ...GET, http: { method: 'POST', path: '/x' } }],
    ['invoke-only, which a silent transition is too', { ...GET, http: undefined }],
    ['emitting', { ...GET, emits: emitsNote('n.read') }],
    ['a projection rather than the entity’s own fields', { ...GET, output: z.object({ id: z.string() }) }],
    ['an input beyond the id', { ...GET, input: z.object({ noteId: z.string(), extra: z.string().optional() }) }],
    ['narrowed to another row', { ...GET, permission: { key: 'note:read', entity: 'folder', idFrom: 'noteId' } }],
    ['resolved in the handler', { ...GET, permission: { key: 'note:read', entity: 'note', resolved: 'x' } }],
    ['narrowing per row', { ...GET, narrows: { key: 'note:read', entity: 'note', idField: 'id' } }],
    ['gating fields', { ...GET, gates: { title: 'note:write' } }],
    ['admitting the bin', { ...GET, trashed: 'admits' }],
  ])('not when %s', (_, decl) => {
    expect(kindOf(decl)).toBeUndefined();
  });

  it('not over a trashable entity behind a scope key, where the host could not refuse a binned row', () => {
    const bin = { ...GET, input: z.object({ binId: z.string() }), output: entities.bin.fields };
    expect(kindOf({ ...bin, permission: 'note:read' })).toBeUndefined();
    expect(kindOf({ ...bin, permission: { key: 'note:read', entity: 'bin', idFrom: 'binId' } })).toBe('get');
  });

  it('not over a composite primary key', () => {
    expect(kindOf({ ...GET, permission: 'note:read', input: z.object({ left: z.string() }), output: entities.pair.fields })).toBeUndefined();
  });
});

describe('derivationOf — list', () => {
  it('derives a kernel-composed page, scoped to the parent by its id column', () => {
    expect(derivationOf(LIST, entities)).toMatchObject({
      kind: 'list',
      entity: 'note',
      permission: { key: 'note:read', entity: 'folder', idFrom: 'folderId' },
      filters: [
        { field: 'folderId', column: 'folder_id' },
        { field: 'status', column: 'status' },
      ],
      total: false,
    });
    expect(derivationOf({ ...LIST, paged: { ...LIST.paged, total: true } }, entities)).toMatchObject({ total: true });
  });

  it('derives an unscoped page behind a scope key, with no input at all', () => {
    expect(
      derivationOf({ ...LIST, permission: 'note:read', input: undefined, http: { method: 'GET', path: '/notes' } }, entities),
    ).toMatchObject({ kind: 'list', filters: [] });
  });

  it.each([
    ['not paged over an entity', { ...LIST, paged: undefined }],
    ['a projection', { ...LIST, output: z.object({ id: z.string() }) }],
    ['narrowed to an entity that is not a parent', { ...LIST, permission: { key: 'note:read', entity: 'bin', idFrom: 'folderId' } }],
    [
      'the parent id is not a declared filter',
      { ...LIST, paged: { over: { entity: 'note', sortable: ['rank'], filterable: ['status'] } } },
    ],
    ['an input that is no filter', { ...LIST, input: z.object({ folderId: z.string(), q: z.string().optional() }) }],
    ['a required input beyond the parent id', { ...LIST, input: z.object({ folderId: z.string(), status: z.enum(['draft', 'done']) }) }],
    ['a filter with a default', { ...LIST, input: z.object({ folderId: z.string(), status: z.enum(['draft', 'done']).default('draft') }) }],
    // The handler would bind `true` against a 0/1 column — the mapping is the handler's.
    ['a filter of another type than its column', { ...LIST, input: z.object({ folderId: z.string(), pinned: z.boolean().optional() }) }],
    // A page is a read: matched exactly, as `get` is.
    ['served as anything but GET', { ...LIST, http: { method: 'POST', path: '/folders/{folderId}/notes' } }],
    ['invoke-only, which a silent transition is too', { ...LIST, http: undefined }],
    ['emitting', { ...LIST, emits: emitsNote('n.listed') }],
    // The check is on folder `title`, the filter on the `title` column: a declared filter, of the
    // same type, and not the link to the folder — so the page would not be the checked folder's.
    [
      'the parent id filters a column that is not the link to the checked parent',
      {
        ...LIST,
        permission: { key: 'note:read', entity: 'folder', idFrom: 'title' },
        input: z.object({ title: z.string() }),
        paged: { over: { entity: 'note', sortable: ['rank'], filterable: ['folder_id', 'title'] } },
        http: { method: 'GET', path: '/folders/{title}/notes' },
      },
    ],
  ])('not when %s', (_, decl) => {
    expect(kindOf(decl)).toBeUndefined();
  });

  it('refuses `derive: list` on a declaration that is not a read, or filters the wrong column', () => {
    const post = { ...LIST, http: { method: 'POST', path: '/folders/{folderId}/notes' }, emits: emitsNote('n.listed') };
    expect(() => define({ 'n/list': { ...post, derive: 'list' } as never })).toThrow(
      "model: 'n/list' declares `derive: 'list'`, but it emits, and a read announces nothing.\n" +
        '  Remedy: make the declaration the shape it derives, or drop `derive` and write the handler.',
    );
    expect(() => define({ 'n/list': { ...LIST, http: { method: 'POST', path: '/x' }, derive: 'list' } })).toThrow(
      "model: 'n/list' declares `derive: 'list'`, but it is not served as GET, the method that says it only reads.",
    );
    const misLinked = {
      ...LIST,
      permission: { key: 'note:read', entity: 'folder', idFrom: 'title' },
      input: z.object({ title: z.string() }),
      paged: { over: { entity: 'note', sortable: ['rank'], filterable: ['folder_id', 'title'] } },
      http: { method: 'GET', path: '/folders/{title}/notes' },
    } as const;
    expect(() => define({ 'n/list': { ...misLinked, derive: 'list' } })).toThrow(
      "model: 'n/list' declares `derive: 'list'`, but the parent's id 'title' filters column 'title', which is not the link to 'folder' ('folder_id').",
    );
  });

  it('(a) does not call a paged POST that emits derivable — it is a command, and its handler is its own', () => {
    // Cast: the type rejects this declaration already; the runtime gate is what is under test.
    const post = { ...LIST, http: { method: 'POST', path: '/folders/{folderId}/notes' }, emits: emitsNote('n.listed') };
    expect(kindOf(post)).toBeUndefined();
    expect(() => define({ 'n/run': post as never })).not.toThrow();
  });
});

describe('derivationOf — update', () => {
  it('derives the PATCH field bag, field by column', () => {
    expect(derivationOf(UPDATE, entities)).toMatchObject({
      kind: 'update',
      entity: 'note',
      idFrom: 'noteId',
      fields: [
        { field: 'title', column: 'title' },
        { field: 'body', column: 'body' },
      ],
      emit: { type: 'n.updated', schemaVersion: 1, piiClass: 'none', payload: ['id'] },
    });
  });

  it.each([
    ['not PATCH', { ...UPDATE, http: { method: 'PUT', path: '/notes/{noteId}' } }],
    ['without concurrency, which would lose updates', { ...UPDATE, concurrency: undefined }],
    ['silent', { ...UPDATE, emits: undefined }],
    ['announcing another entity', { ...UPDATE, emits: { ...emitsNote('n.updated'), entity: 'folder' } }],
    ['announcing a subject other than the row', { ...UPDATE, emits: { ...emitsNote('n.updated'), entityIdFrom: 'folder_id' } }],
    ['a projection', { ...UPDATE, output: z.object({ id: z.string() }) }],
    ['scope-wide', { ...UPDATE, permission: 'note:write' }],
    ['writing an enum column, a lifecycle edge', { ...UPDATE, input: z.object({ noteId: z.string(), status: z.enum(['draft', 'done']).optional() }) }],
    ['clearing a column that is not nullable', { ...UPDATE, input: z.object({ noteId: z.string(), title: z.string().nullable().optional() }) }],
    ['a body field of another type', { ...UPDATE, input: z.object({ noteId: z.string(), rank: z.string().optional() }) }],
    ['a body field that is no column', { ...UPDATE, input: z.object({ noteId: z.string(), colour: z.string().optional() }) }],
    ['rewriting the id', { ...UPDATE, input: z.object({ noteId: z.string(), id: z.string().optional() }) }],
    ['a required body field', { ...UPDATE, input: z.object({ noteId: z.string(), title: z.string() }) }],
    ['a patchException', { ...UPDATE, patchException: 'x' }],
  ])('not when %s', (_, decl) => {
    expect(kindOf(decl)).toBeUndefined();
  });
});

describe('derivationOf — delete', () => {
  it('derives removing one row with no child entity', () => {
    expect(derivationOf(DELETE, entities)).toMatchObject({ kind: 'delete', entity: 'note', idFrom: 'noteId' });
  });

  it.each([
    ['not DELETE', { ...DELETE, http: { method: 'POST', path: '/notes/{noteId}/delete' } }],
    ['answering anything but { id, deleted }', { ...DELETE, output: z.object({ id: z.string() }) }],
    ['silent', { ...DELETE, emits: undefined }],
    ['an input beyond the id', { ...DELETE, input: z.object({ noteId: z.string(), why: z.string().optional() }) }],
  ])('not when %s', (_, decl) => {
    expect(kindOf(decl)).toBeUndefined();
  });

  it('not over an entity a child declares as parent — a cascade is authored', () => {
    const folderDelete = {
      ...DELETE,
      permission: { key: 'note:write', entity: 'folder', idFrom: 'folderId' },
      input: z.object({ folderId: z.string() }),
      emits: { ...emitsNote('f.deleted'), entity: 'folder' },
    };
    expect(kindOf(folderDelete)).toBeUndefined();
  });
});

describe('the gate', () => {
  it('records the plan for a `derive` declaration, and none for anything else', () => {
    const ops = define({
      'n/get': { ...GET, derive: 'get' },
      'n/list': { ...LIST, authored: 'it ranks pinned notes first' },
      'n/other': { summary: 's', permission: 'note:read', output: z.object({ ok: z.boolean() }) },
    });
    expect(derivationPlanOf(ops['n/get'])).toMatchObject({ kind: 'get', entity: 'note' });
    expect(derivationPlanOf(ops['n/list'])).toBeUndefined();
    expect(derivationPlanOf(ops['n/other'])).toBeUndefined();
  });

  it('(a) refuses a derivable operation that declares neither, naming both remedies', () => {
    expect(() => define({ 'n/get': GET })).toThrow(
      "model: 'n/get' is derivable from the model as `get` over 'note', and declares neither `derive` nor `authored`.\n" +
        '  A hand-written get restates its declaration, and each restatement drifts (#1773).\n' +
        "  Remedy: declare `derive: 'get'` and delete its handler, or declare `authored: '<why the derived get is wrong here>'`.",
    );
  });

  it('(b) refuses a `derive` whose shape does not match, naming the clause', () => {
    expect(() => define({ 'n/get': { ...GET, derive: 'list' } })).toThrow(
      "model: 'n/get' declares `derive: 'list'`, but it is not a kernel-composed page (`paged.over`).\n" +
        '  Remedy: make the declaration the shape it derives, or drop `derive` and write the handler.',
    );
    const statusInput = z.object({ noteId: z.string(), status: z.enum(['draft', 'done']).optional() });
    expect(() => define({ 'n/upd': { ...UPDATE, input: statusInput, derive: 'update' } })).toThrow(
      "model: 'n/upd' declares `derive: 'update'`, but column 'status' is an enum — a change of state is a lifecycle edge with its own operation.",
    );
    // A kind that does not exist, through a cast, is refused by name too.
    expect(() => define({ 'n/get': { ...GET, derive: 'create' as never } })).toThrow(
      "model: 'n/get' declares `derive: 'create'` — the derivable shapes are get, list, update, delete, archive, unarchive, trash, restore, trashed.\n" +
        '  Remedy: declare one of them, or drop `derive` and write the handler.',
    );
  });

  it('(c) refuses a blank `authored`, and one on an operation nothing could derive', () => {
    expect(() => define({ 'n/get': { ...GET, authored: '  ' } })).toThrow(
      "model: 'n/get' declares `authored` without a reason.\n" +
        '  Remedy: say what the derived handler would get wrong here, or declare `derive` and delete the handler.',
    );
    expect(() =>
      define({ 'n/ping': { summary: 's', permission: 'note:read', output: z.object({ ok: z.boolean() }), authored: 'habit' } }),
    ).toThrow(
      "model: 'n/ping' declares `authored`, but nothing about it is derivable — it matches none of get, list, update, delete, archive, unarchive, trash, restore, trashed, " +
        'so every handler for it is authored already.\n' +
        '  Remedy: remove `authored`.',
    );
  });

  it('(d) refuses `derive` and `authored` together', () => {
    // The type refuses the pair as well; the cast stands for a declaration built around it.
    expect(() => define({ 'n/get': { ...GET, derive: 'get', authored: 'both' } as never })).toThrow(
      "model: 'n/get' declares both `derive` and `authored` — a handler is written by the platform or by you, not both.\n" +
        '  Remedy: keep `derive` and delete the handler, or keep `authored` and drop `derive`.',
    );
  });

  it('leaves a non-derivable operation alone', () => {
    expect(() => define({ 'n/ping': { summary: 's', permission: 'note:read', output: z.object({ ok: z.boolean() }) } })).not.toThrow();
  });

  it('types: `derive` and `authored` are exclusive, and `derive` names a shape', () => {
    // Never called: these are compile-time cases, and each would throw at load.
    const declarations = () => [
      // @ts-expect-error — both at once is refused at compile time.
      define({ 'n/get': { ...GET, derive: 'get', authored: 'x' } }),
      // @ts-expect-error — `create` is not a derivable shape yet.
      define({ 'n/get': { ...GET, derive: 'create' } }),
    ];
    expect(declarations).toBeTypeOf('function');
  });
});

// #119: the moves and the bin, derived from the entity's own `archive` / `trash` declaration.
const byShelf = z.object({ shelfId: z.string() });
const ARCHIVE = {
  summary: 's',
  permission: { key: 'note:archive', entity: 'shelf', idFrom: 'shelfId' },
  input: byShelf,
  output: entityStateOutput,
  http: { method: 'POST', path: '/shelves/{shelfId}/archive' },
} as const;
const TRASH = {
  ...ARCHIVE,
  permission: { key: 'note:write', entity: 'shelf', idFrom: 'shelfId' },
  http: { method: 'POST', path: '/shelves/{shelfId}/trash' },
} as const;
const RESTORE = { ...TRASH, trashed: 'admits', http: { method: 'POST', path: '/shelves/{shelfId}/restore' } } as const;
const TRASHED = {
  summary: 's',
  narrows: { reason: 'the bin, row by row', checks: ['note:write'] },
  output: entities.shelf.fields,
  paged: { over: { entity: 'shelf', sortable: ['label'], filterable: ['label'] } },
  http: { method: 'GET', path: '/shelves/trash' },
} as const;
const SHELVES = {
  summary: 's',
  permission: 'note:read',
  input: z.object({ view: z.enum(['active', 'archived']).optional() }),
  output: entities.shelf.fields,
  paged: { over: { entity: 'shelf', sortable: ['label'] } },
  http: { method: 'GET', path: '/shelves' },
} as const;

describe('derivationOf — the moves (#119)', () => {
  it('derives a move under the key the entity declares for it', () => {
    expect(derivationOf(ARCHIVE, entities)).toEqual({
      kind: 'archive',
      entity: 'shelf',
      table: 't_shelves',
      primaryKey: 'id',
      columns: ['id', 'label'],
      permission: { key: 'note:archive', entity: 'shelf', idFrom: 'shelfId' },
      idFrom: 'shelfId',
    });
    expect(derivationOf(TRASH, entities)).toMatchObject({ kind: 'trash', permission: { key: 'note:write' } });
  });

  it('tells a restore from a trash by the one line that differs: `trashed: admits`', () => {
    expect(kindOf(RESTORE)).toBe('restore');
    expect(kindOf({ ...ARCHIVE, trashed: 'admits' })).toBeUndefined();
  });

  it.each([
    ['served as anything but POST', { ...ARCHIVE, http: { method: 'PATCH', path: '/shelves/{shelfId}' } }],
    ['invoke-only', { ...ARCHIVE, http: undefined }],
    ['declaring an event the kernel already emits', { ...ARCHIVE, emits: { ...emitsNote('s.archived'), entity: 'shelf' } }],
    // The same fields, but not THE schema: one answer shape across verticals is the point.
    ['answering a look-alike of entityStateOutput', { ...ARCHIVE, output: z.object({ id: z.string(), state: entityStateName }) }],
    ['scope-wide', { ...ARCHIVE, permission: 'note:archive' }],
    // A move under the entity's ordinary read key is no move at all. (Under the OTHER move's key
    // it is that move — which is why `derive` names one, and is refused under the wrong key.)
    ['under a key the entity declares for nothing', { ...ARCHIVE, permission: { ...ARCHIVE.permission, key: 'note:read' } }],
    ['an input beyond the id', { ...ARCHIVE, input: z.object({ shelfId: z.string(), why: z.string().optional() }) }],
    ['the id under another name than the check reads', { ...ARCHIVE, input: z.object({ id: z.string() }) }],
    ['paged', { ...ARCHIVE, paged: { over: { entity: 'shelf', sortable: ['label'] } } }],
    ['purging', { ...TRASH, trashed: 'purges' }],
  ])('not when %s', (_, decl) => {
    expect(kindOf(decl)).toBeUndefined();
  });

  it('not over an entity that declares no archive (or no trash)', () => {
    const overBin = { ...ARCHIVE, permission: { key: 'note:write', entity: 'bin', idFrom: 'binId' }, input: z.object({ binId: z.string() }), http: { method: 'POST', path: '/bins/{binId}/archive' } } as const;
    expect(kindOf(overBin)).toBe('trash');
    expect(() => define({ 'b/archive': { ...overBin, derive: 'archive' } })).toThrow(
      "model: 'b/archive' declares `derive: 'archive'`, but 'bin' declares no `archive`.",
    );
    const overNote = { ...ARCHIVE, permission: { key: 'note:write', ...noteRow }, input: byNote };
    expect(kindOf(overNote)).toBeUndefined();
  });

  it('refuses `derive: restore` without `trashed: admits`, and `derive: trash` with it', () => {
    expect(() => define({ 's/restore': { ...TRASH, derive: 'restore' } })).toThrow(
      "model: 's/restore' declares `derive: 'restore'`, but it does not declare `trashed: 'admits'`, and a restore is the move that reaches a binned row.",
    );
    expect(() => define({ 's/trash': { ...RESTORE, derive: 'trash' } })).toThrow(
      "model: 's/trash' declares `derive: 'trash'`, but it declares `trashed: 'admits'` — reaching the bin is authored.",
    );
  });

  it('refuses a move checked under the wrong key, naming the key the entity declares', () => {
    expect(() => define({ 's/archive': { ...ARCHIVE, permission: { ...ARCHIVE.permission, key: 'note:write' }, derive: 'archive' } })).toThrow(
      "model: 's/archive' declares `derive: 'archive'`, but its check is 'note:write', not the key 'shelf' declares for its archive, 'note:archive'.",
    );
  });

  it('records the move `derive` names: archive and unarchive are one shape, told apart by it', () => {
    const ops = define({
      's/archive': { ...ARCHIVE, derive: 'archive' },
      's/unarchive': { ...ARCHIVE, http: { method: 'POST', path: '/shelves/{shelfId}/unarchive' }, derive: 'unarchive' },
      's/restore': { ...RESTORE, derive: 'restore' },
    });
    expect(derivationPlanOf(ops['s/archive'])).toMatchObject({ kind: 'archive' });
    expect(derivationPlanOf(ops['s/unarchive'])).toMatchObject({ kind: 'unarchive' });
    expect(derivationPlanOf(ops['s/restore'])).toMatchObject({ kind: 'restore' });
  });

  it('(a) names every move a hand-written one could be, when it declares neither', () => {
    const unarchive = { ...ARCHIVE, http: { method: 'POST', path: '/shelves/{shelfId}/unarchive' } } as const;
    expect(() => define({ 's/unarchive': unarchive })).toThrow(
      "model: 's/unarchive' is derivable from the model as `archive` or `unarchive` over 'shelf', and declares neither `derive` nor `authored`.\n" +
        '  A hand-written archive restates its declaration, and each restatement drifts (#1773).\n' +
        "  Remedy: declare `derive: 'archive'` or `derive: 'unarchive'` and delete its handler, or declare `authored: '<why the derived archive is wrong here>'`.",
    );
    expect(() => define({ 's/restore': RESTORE })).toThrow(
      "model: 's/restore' is derivable from the model as `restore` over 'shelf', and declares neither `derive` nor `authored`.",
    );
  });
});

describe('derivationOf — the bin (#119)', () => {
  it('derives a page of the bin, its filters as a list declares them, checked by the walk', () => {
    expect(derivationOf(TRASHED, entities)).toEqual({
      kind: 'trashed',
      entity: 'shelf',
      table: 't_shelves',
      primaryKey: 'id',
      columns: ['id', 'label'],
      permission: { key: 'note:write' },
      filters: [],
    });
    expect(derivationOf({ ...TRASHED, input: z.object({ label: z.string().optional() }) }, entities)).toMatchObject({
      kind: 'trashed',
      filters: [{ field: 'label', column: 'label' }],
    });
  });

  it.each([
    ['with a leading check, which would deny a key narrowed to binned rows', { ...TRASHED, permission: 'note:write' }],
    ['narrowed under another key', { ...TRASHED, narrows: { reason: 'r', checks: ['note:read'] } }],
    ['narrowed under more than the trash key', { ...TRASHED, narrows: { reason: 'r', checks: ['note:write', 'note:read'] } }],
    ['narrowed under nothing', { ...TRASHED, narrows: { reason: 'r', checks: [] } }],
    // The trash key listed AND the flag saying nothing is checked: the flag is a claim the walk
    // contradicts, and it is refused rather than trusted either way.
    ['declaring it checks nothing beside the trash key', { ...TRASHED, narrows: { reason: 'r', checks: ['note:write'], unchecked: true } }],
    ['asking for a total', { ...TRASHED, paged: { ...TRASHED.paged, total: true } }],
    ['over an entity that declares no trash', { ...TRASHED, output: entities.note.fields, paged: { over: { entity: 'note', sortable: ['rank'] } } }],
    ['a projection', { ...TRASHED, output: z.object({ id: z.string() }) }],
    ['served as anything but GET', { ...TRASHED, http: { method: 'POST', path: '/shelves/trash' } }],
    ['emitting', { ...TRASHED, emits: { ...emitsNote('s.listed'), entity: 'shelf' } }],
    ['a required input', { ...TRASHED, input: z.object({ label: z.string() }) }],
    ['an input that is no filter', { ...TRASHED, input: z.object({ q: z.string().optional() }) }],
    ['a filter with a default', { ...TRASHED, input: z.object({ label: z.string().default('x') }) }],
    ['not paged over an entity', { ...TRASHED, paged: undefined }],
  ])('not when %s', (_, decl) => {
    expect(kindOf(decl)).toBeUndefined();
  });

  it('derives with the trash key alone in `narrows`, and not once `unchecked` rides beside it', () => {
    const narrows = { reason: 'r', checks: ['note:write'] } as const;
    expect(kindOf({ ...TRASHED, narrows })).toBe('trashed');
    expect(kindOf({ ...TRASHED, narrows: { ...narrows, unchecked: true } })).toBeUndefined();
  });

  it('is still no `list`: a page with `narrows` is a walk unless it is the bin', () => {
    expect(kindOf({ ...SHELVES, narrows: { reason: 'r', checks: ['note:read'] }, permission: undefined })).toBeUndefined();
  });
});

describe('derivationOf — the view on a derived list (#119)', () => {
  it('passes `view` to the page of an archivable entity', () => {
    expect(derivationOf(SHELVES, entities)).toMatchObject({ kind: 'list', entity: 'shelf', filters: [], viewFrom: 'view' });
    expect(derivationOf({ ...SHELVES, input: undefined }, entities)).not.toHaveProperty('viewFrom');
  });

  it.each([
    ['naming the bin, which is its own read', z.object({ view: z.enum(['active', 'archived', 'trashed']).optional() })],
    ['with a default', z.object({ view: z.enum(['active', 'archived']).default('active') })],
    ['a free string', z.object({ view: z.string().optional() })],
    ['required', z.object({ view: z.enum(['active', 'archived']) })],
  ])('not when the view is %s', (_, input) => {
    expect(kindOf({ ...SHELVES, input })).toBeUndefined();
  });

  it('not on an entity that declares no archive, where `view` is just an undeclared filter', () => {
    const bins = { ...SHELVES, output: entities.bin.fields, paged: { over: { entity: 'bin', sortable: ['label'] } } };
    expect(kindOf(bins)).toBeUndefined();
    expect(kindOf({ ...bins, input: undefined })).toBe('list');
  });

  it('not when `view` is also a declared filterable column', () => {
    const decl = { ...SHELVES, paged: { over: { entity: 'shelf', sortable: ['label'], filterable: ['view'] } }, derive: 'list' };
    expect(kindOf(decl)).toBeUndefined();
    expect(() => define({ 's/list': decl as never })).toThrow("'view' is both the archive view and a declared `filterable` column");
  });
});
