/**
 * The tuple-ref grammar the permission walk parses with, and the write-side check that
 * holds `ctx.link` / `ctx.grant` to it (#1856).
 *
 * The widening is meant to add exactly one thing: an upper-case letter in the namespace
 * half. So the pre-#1856 pattern is kept here as a literal, and each case is asserted
 * against both. An exhaustive sweep over a small alphabet then shows that the only strings
 * the new pattern accepts and the old one refused have upper case before the first colon,
 * and that the new pattern still accepts everything the old one did.
 */
import { describe, expect, it } from 'vitest';
import { entityObjectRef, objectRef } from '../src/permission.js';
import { errorCodeOf } from '../src/errors.js';
import { eventAuthorization } from '../src/events.js';

/** `objectRef` as it stood on main before #1856 — the "before" column. */
const BEFORE = /^[a-z0-9_-]+:[^\s]+$/;

const before = (s: string) => BEFORE.test(s);
const after = (s: string) => objectRef.safeParse(s).success;

/**
 * [label, input, accepted before, accepted after]. The PR body's accepts/refuses table
 * is this table.
 */
const CASES: [string, string, boolean, boolean][] = [
  ['lower-case type', 'message:01J', true, true],
  ['camelCase type', 'aiTurn:01J', false, true],
  ['upper-case first letter', 'AiTurn:01J', false, true],
  ['all upper case', 'KB:01J', false, true],
  ['digits in type', 'v2item:01J', true, true],
  ['digit first', '9item:01J', true, true],
  ['_ and - in type', 'kb_source-x:01J', true, true],
  ['_ first', '_item:01J', true, true],
  ['- first', '-item:01J', true, true],
  ['kernel namespace', 'principal:01J', true, true],
  ['colon in the id', 'item:a:b', true, true],
  ['doubled colon (id starts with a colon)', 'item::01J', true, true],
  ['non-ASCII in the id', 'item:é', true, true],
  ['zero-width space in the id (not \\s)', 'item:a\u200bb', true, true],
  ['empty string', '', false, false],
  ['no colon', 'item', false, false],
  ['empty namespace (leading colon)', ':01J', false, false],
  ['empty id (trailing colon)', 'item:', false, false],
  ['only a colon', ':', false, false],
  ['space in the type', 'ai Turn:01J', false, false],
  ['space in the id', 'item:01 J', false, false],
  ['leading space', ' item:01J', false, false],
  ['trailing space', 'item:01J ', false, false],
  ['tab in the id', 'item:01\tJ', false, false],
  ['newline in the id', 'item:01J\nprincipal:x', false, false],
  ['newline before the type', '\nitem:01J', false, false],
  ['carriage return in the id', 'item:01J\r', false, false],
  ['no-break space in the id', 'item:01\u00a0J', false, false],
  ['line separator in the id', 'item:01\u2028J', false, false],
  ['ideographic space in the id', 'item:01\u3000J', false, false],
  ['non-ASCII letter in the type', 'ítem:01J', false, false],
  ['non-ASCII upper case in the type', 'Ítem:01J', false, false],
  ['dot in the type', 'kb.article:01J', false, false],
  ['slash in the type', 'kb/article:01J', false, false],
  ['@ in the type', 'a@b:01J', false, false],
  ['% in the type', 'a%20b:01J', false, false],
  ['zero-width space in the type', 'ai\u200bTurn:01J', false, false],
  ['fullwidth colon as separator', 'item\uff1a01J', false, false],
];

describe('objectRef (#1856)', () => {
  it.each(CASES)('%s: %j — before %s, after %s', (_label, input, was, is) => {
    expect(before(input)).toBe(was);
    expect(after(input)).toBe(is);
  });

  /**
   * Every string up to four characters over an alphabet that holds each class the
   * grammar distinguishes: a lower- and an upper-case letter, a digit, `_`, `-`, the
   * colon, whitespace of three kinds, non-ASCII letters, and punctuation.
   *
   * Two properties, over all of them:
   * - nothing the old pattern accepted is refused now (so a ref stored and walked
   *   before this change still walks), and
   * - a string the new pattern accepts is one the old pattern accepts once its
   *   namespace is lower-cased, so upper case in the namespace is the only thing added.
   */
  it('over every short string: accepts a superset of before, and adds only upper case in the namespace', () => {
    const alphabet = ['a', 'Z', '0', '_', '-', ':', ' ', '\t', '\n', '\u00a0', 'é', 'É', '.', '/'];
    let checked = 0;
    let added = 0;
    const visit = (s: string) => {
      checked++;
      const was = before(s);
      const is = after(s);
      if (was) expect(is, JSON.stringify(s)).toBe(true);
      if (is && !was) {
        added++;
        const colon = s.indexOf(':');
        const lowered = s.slice(0, colon).toLowerCase() + s.slice(colon);
        expect(before(lowered), JSON.stringify(s)).toBe(true);
        expect(s.slice(0, colon), JSON.stringify(s)).toMatch(/[A-Z]/);
      }
    };
    const walk = (prefix: string, depth: number) => {
      visit(prefix);
      if (depth === 0) return;
      for (const c of alphabet) walk(prefix + c, depth - 1);
    };
    walk('', 4);
    expect(checked).toBeGreaterThan(alphabet.length ** 4);
    // The sweep has to reach the case it is about, or it proves nothing.
    expect(added).toBeGreaterThan(0);
  });
});

describe('entityObjectRef: the write-side check (#1856)', () => {
  const refused = (entityType: unknown, entityId: unknown) => {
    try {
      entityObjectRef({ entityType, entityId } as never, 'ctx.link');
    } catch (err) {
      return err as Error & { extensions?: { errors?: { path: string }[] } };
    }
    return undefined;
  };

  it.each([
    ['aiTurn', '01J'],
    ['message', '01J'],
    ['9item', 'x'],
    ['_a-b', 'x:y'],
    ['KB', 'é'],
  ])('accepts %s / %s and returns the tuple object, which the walk parses', (entityType, entityId) => {
    const ref = entityObjectRef({ entityType, entityId }, 'ctx.link');
    expect(ref).toBe(`${entityType}:${entityId}`);
    expect(objectRef.safeParse(ref).success).toBe(true);
  });

  it('accepts a colon in the id, which lands after the split and reads back as the same ref', () => {
    const ref = entityObjectRef({ entityType: 'item', entityId: 'a:b' }, 'ctx.link');
    expect(ref).toBe('item:a:b');
    const at = ref.indexOf(':');
    expect({ entityType: ref.slice(0, at), entityId: ref.slice(at + 1) }).toEqual({
      entityType: 'item',
      entityId: 'a:b',
    });
  });

  it.each([
    ['colon in the type (would read back as a different ref)', 'a:b', 'c', 'entityType'],
    ['empty type', '', '01J', 'entityType'],
    ['space in the type', 'ai Turn', '01J', 'entityType'],
    ['non-ASCII in the type', 'ítem', '01J', 'entityType'],
    ['dot in the type', 'kb.article', '01J', 'entityType'],
    ['newline in the type', 'item\n', '01J', 'entityType'],
    ['empty id', 'item', '', 'entityId'],
    ['space in the id', 'item', '01 J', 'entityId'],
    ['newline in the id', 'item', '01J\nprincipal:x', 'entityId'],
    ['no-break space in the id', 'item', '01\u00a0J', 'entityId'],
    ['a type that is not a string', 42, '01J', 'entityType'],
    ['an id that is not a string', 'item', null, 'entityId'],
  ])('refuses %s with validation_failed naming the field', (_label, type, id, path) => {
    const err = refused(type, id);
    expect(err).toBeDefined();
    expect(errorCodeOf(err!)).toBe('validation_failed');
    expect(err!.name).toBe('Substrat.validation_failed');
    expect(err!.message).toMatch(/^ctx\.link: malformed entity ref/);
    expect(err!.extensions?.errors?.map((e) => e.path)).toEqual([path]);
  });

  it('names both halves when both are wrong', () => {
    expect(refused('a b', '')?.extensions?.errors?.map((e) => e.path)).toEqual(['entityType', 'entityId']);
  });
});

/**
 * A kernel namespace is refused as an entity type in ANY case. The walk compares tuple
 * strings exactly, but some spine SQL matches a namespace with LIKE, which ignores ASCII
 * case, so `Scope:x` and `scope:x` are not safely distinct everywhere.
 */
describe('entityObjectRef: kernel namespaces are not entity types', () => {
  const RESERVED = ['principal', 'org', 'tenant', 'scope', 'role', 'connection', 'capability', 'system', 'vertical'];
  const spellings = (name: string) => [
    name,
    name.toUpperCase(),
    name[0]!.toUpperCase() + name.slice(1),
    [...name].map((c, i) => (i % 2 ? c.toUpperCase() : c)).join(''),
  ];

  it.each(RESERVED)('refuses %s in every case, naming the type', (name) => {
    for (const entityType of spellings(name)) {
      let err: (Error & { extensions?: { errors?: { path: string; message: string }[] } }) | undefined;
      try {
        entityObjectRef({ entityType, entityId: '01J' }, 'ctx.link');
      } catch (e) {
        err = e as typeof err;
      }
      expect(errorCodeOf(err!), entityType).toBe('validation_failed');
      expect(err!.extensions?.errors).toEqual([
        { path: 'entityType', message: expect.stringContaining('kernel namespace') },
      ]);
    }
  });

  it.each(['scopeItem', 'orgUnit', 'Scopes', 'tenants', 'roleAssignment', 'systemNote', 'subscope', 'vertical-slice', 'principal_x'])(
    'accepts %s, which only contains a kernel namespace',
    (entityType) => {
      expect(entityObjectRef({ entityType, entityId: '01J' }, 'ctx.link')).toBe(`${entityType}:01J`);
    },
  );
});

/**
 * The event envelope's `authorization[].grant` records a grant's tuple object, so it is
 * held to exactly the grammar the walk parses with (#1856). Every row of the table above
 * gives the same verdict through both.
 */
describe('eventAuthorization.grant takes the same grammar as objectRef (#1856)', () => {
  it.each(CASES)('%s: %j', (_label, input, _was, is) => {
    expect(eventAuthorization.safeParse({ permission: 'perm:read', grant: input }).success).toBe(is);
  });

  it('a grant stays optional: a role-authorized entry has none', () => {
    expect(eventAuthorization.safeParse({ permission: 'perm:read' }).success).toBe(true);
  });
});
