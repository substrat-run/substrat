/**
 * The cursor `ctx.page` mints and reads (#2001, K-44), held at `listQuery`, the one
 * function both adapters compose a page with.
 *
 * What is pinned: a minted cursor round-trips whatever its sort value holds; a pre-#2001
 * cursor is told apart from one BY CONSTRUCTION — including one whose value looks like
 * the old readable tag (#2018 review) — and continues only in the walk it came from; and
 * anything else is refused with `cursor_restart`, never read as a position.
 */
import { describe, expect, it } from 'vitest';
import { PAGE_CURSOR_RESTART, errorCodeOf } from '@substrat-run/contracts';
import { cursorOf, listQuery, type ListIndexPlan } from '../src/list-index.js';
import { toBase64url } from '../src/base64url.js';

const plan: ListIndexPlan = {
  moduleId: '@acme/things',
  entityType: 'thing',
  table: 'things',
  idColumn: 'id',
  sortable: ['name', 'id'],
  filterable: [],
  indexStem: '_substrat_list_acme_things_thing',
};
const ID = '01JZ0000000000000000THNG01';

/** The keyset arguments a cursor composed into: `[value, value, id]`, or `[value]` by id. */
const keysetOf = (params: Parameters<typeof listQuery>[1]): unknown[] => listQuery(plan, params).params.slice(0, -1);

const restart = (fn: () => unknown): void => {
  let err: unknown;
  try {
    fn();
  } catch (e) {
    err = e;
  }
  expect(errorCodeOf(err), 'the cursor was read as a position').toBe('validation_failed');
  expect(err).toMatchObject({ extensions: { reason: PAGE_CURSOR_RESTART } });
};

const envelope = (body: unknown): string => toBase64url(new TextEncoder().encode(JSON.stringify(body)));

describe('a minted cursor', () => {
  it.each([
    ['a pipe', 'x|y'],
    ['dots and the old tag syntax', 'asc.name.foo'],
    ['unicode', 'Åsa 😀 名前'],
    ['nothing at all', ''],
    ['a value that is itself a ULID', ID],
  ])('round-trips a sort value holding %s', (_, value) => {
    const cursor = cursorOf({ name: value, id: ID }, 'name', 'id', 'desc');
    expect(cursor).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(keysetOf({ limit: 5, order: 'desc', cursor })).toEqual([value, value, ID]);
  });

  it('round-trips a walk by the id itself, as one value', () => {
    const cursor = cursorOf({ name: 'n', id: ID }, 'id', 'id', 'asc');
    expect(keysetOf({ limit: 5, sort: 'id', cursor })).toEqual([ID]);
  });

  it('is refused under the other order, or another sort', () => {
    const cursor = cursorOf({ name: 'n', id: ID }, 'name', 'id', 'desc');
    restart(() => listQuery(plan, { limit: 5, order: 'asc', cursor }));
    restart(() => listQuery(plan, { limit: 5, sort: 'id', order: 'desc', cursor }));
  });
});

describe('a malformed envelope is refused, never read as a position', () => {
  const good = { v: 1, order: 'asc', sort: 'name', value: 'n', id: ID };
  it.each([
    ['not base64url', 'eyJ2Ijox!!'],
    ['an impossible base64 length', 'eyJ2I'],
    ['bytes that are not UTF-8', toBase64url(new Uint8Array([0xff, 0xfe, 0x7b]))],
    ['UTF-8 that is not JSON', toBase64url(new TextEncoder().encode('{not json'))],
    ['another version', envelope({ ...good, v: 2 })],
    ['an order that is neither', envelope({ ...good, order: 'sideways' })],
    ['a sort that is no identifier', envelope({ ...good, sort: 'name; DROP TABLE things' })],
    ['a value that is not a string', envelope({ ...good, value: 7 })],
    ['an id that is not a string', envelope({ ...good, id: 7 })],
    ['a field nobody mints', envelope({ ...good, extra: true })],
    ['no id on a walk that needs one', envelope({ v: 1, order: 'asc', sort: 'name', value: 'n' })],
  ])('%s', (_, cursor) => {
    restart(() => listQuery(plan, { limit: 5, cursor }));
  });

  it('an id on a walk by the id itself', () => {
    restart(() => listQuery(plan, { limit: 5, sort: 'id', cursor: envelope({ ...good, sort: 'id', value: ID }) }));
  });
});

/**
 * #2018 review: a row named `asc.name.foo` minted the legacy cursor `asc.name.foo|<id>`,
 * which a readable `<order>.<sort>.` tag read as tagged — binding `foo` and skipping or
 * repeating rows. Told apart by construction now, it continues with its whole value.
 */
describe('a pre-#2001 cursor', () => {
  it('whose value carries the old tag syntax continues the asc default walk with its whole value', () => {
    expect(keysetOf({ limit: 5, cursor: `asc.name.foo|${ID}` })).toEqual(['asc.name.foo', 'asc.name.foo', ID]);
    expect(keysetOf({ limit: 5, order: 'asc', cursor: `desc.name.foo|${ID}` })).toEqual([
      'desc.name.foo',
      'desc.name.foo',
      ID,
    ]);
  });

  it('keeps a value holding a pipe whole, since a ULID holds none', () => {
    expect(keysetOf({ limit: 5, cursor: `x|y|${ID}` })).toEqual(['x|y', 'x|y', ID]);
  });

  it('continues as a bare ULID where the default walk is by the id itself', () => {
    const byId: ListIndexPlan = { ...plan, sortable: ['id', 'name'] };
    expect(listQuery(byId, { limit: 5, cursor: ID }).params.slice(0, -1)).toEqual([ID]);
    restart(() => listQuery(byId, { limit: 5, order: 'desc', cursor: ID }));
  });

  it('is refused outside the asc default walk, however its value reads', () => {
    restart(() => listQuery(plan, { limit: 5, order: 'desc', cursor: `asc.name.foo|${ID}` }));
    restart(() => listQuery(plan, { limit: 5, order: 'desc', cursor: `desc.name.foo|${ID}` }));
    restart(() => listQuery(plan, { limit: 5, sort: 'id', cursor: ID }));
  });

  it('is recognised only by its exact shape: an id that is not a ULID is refused', () => {
    restart(() => listQuery(plan, { limit: 5, cursor: 'foo|01B' }));
    restart(() => listQuery(plan, { limit: 5, cursor: 'no-separator-at-all' }));
  });
});
