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
  pair: {
    table: 't_pairs',
    fields: z.object({ left: z.string(), right: z.string() }),
    primaryKey: ['left', 'right'],
  },
});
const PERMS = ['note:read', 'note:write'] as const;
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
  ])('not when %s', (_, decl) => {
    expect(kindOf(decl)).toBeUndefined();
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
      "model: 'n/get' declares `derive: 'create'` — the derivable shapes are get, list, update, delete",
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
      "model: 'n/ping' declares `authored`, but nothing about it is derivable — it matches none of get, list, update, delete, " +
        'so every handler for it is authored already. Remove `authored`.',
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
