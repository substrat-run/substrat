/**
 * #2068 — an entity's `erasure`, derived into the manifest's `erasure` block.
 *
 * The kernel trusts this block to name real columns and to write blanks the columns accept, so
 * every refusal below is a model that would otherwise fail mid-erasure — after the person was
 * told it had started — or reach less than it says. Each refusal has its accepted twin.
 */
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { defineEntities, emitModel, manifestEntities, subjectErasureOf } from '../src/index.js';

const fields = z.object({
  id: z.string(),
  owner: z.string(),
  email: z.string().nullable(),
  name: z.string(),
  code: z.string().min(1),
  score: z.number(),
});

describe('subjectErasureOf (#2068)', () => {
  it('derives each blank: NULL where the field admits it, empty string where only that fits', () => {
    const decl = subjectErasureOf(
      defineEntities({ person: { table: 'people', fields, erasable: ['email', 'name'], erasure: { subjects: ['owner', 'id'] } } }),
    );
    expect(decl).toEqual({
      tables: ['people'],
      entities: [
        {
          entityType: 'person',
          table: 'people',
          mode: 'blank',
          subjects: ['id', 'owner'],
          fields: [
            { name: 'email', blank: null },
            { name: 'name', blank: '' },
          ],
        },
      ],
    });
  });

  it('names an erasable entity with no erasure as unreached, and lists every table as the hook reach', () => {
    const decl = subjectErasureOf(
      defineEntities({
        person: { table: 'people', fields, erasable: ['email'] },
        plain: { table: 'plain', fields: z.object({ id: z.string() }) },
      }),
    );
    expect(decl?.entities).toEqual([{ entityType: 'person', table: 'people', mode: 'unreached', fields: [{ name: 'email', blank: null }] }]);
    expect(decl?.tables).toEqual(['people', 'plain']);
  });

  it('is absent when nothing is erasable — a manifest with nothing personal is unchanged', () => {
    const entities = defineEntities({ plain: { table: 'plain', fields: z.object({ id: z.string() }) } });
    expect(subjectErasureOf(entities)).toBeUndefined();
    expect('erasure' in manifestEntities(entities, {})).toBe(false);
  });

  it('refuses a blank of a field that admits neither NULL nor the empty string — delete is accepted', () => {
    expect(() =>
      subjectErasureOf(defineEntities({ p: { table: 'p', fields, erasable: ['code'], erasure: { subjects: ['owner'] } } })),
    ).toThrow(/admits neither NULL nor ''/);
    expect(() =>
      subjectErasureOf(defineEntities({ p: { table: 'p', fields, erasable: ['score'], erasure: { subjects: ['owner'] } } })),
    ).toThrow(/cannot be blanked/);
    expect(
      subjectErasureOf(defineEntities({ p: { table: 'p', fields, erasable: ['code'], erasure: { subjects: ['owner'], mode: 'delete' } } }))
        ?.entities[0]?.mode,
    ).toBe('delete');
  });

  it("refuses a blank that writes '' into a key column — the second erased row would collide", () => {
    expect(() =>
      subjectErasureOf(
        defineEntities({ p: { table: 'p', fields, key: ['owner', 'name'], erasable: ['name'], erasure: { subjects: ['id'] } } }),
      ),
    ).toThrow(/part of the `key`/);
    // A NULL blank in a key is fine: SQLite admits many NULLs under a UNIQUE.
    expect(
      subjectErasureOf(
        defineEntities({ p: { table: 'p', fields, key: ['owner', 'email'], erasable: ['email'], erasure: { subjects: ['id'] } } }),
      )?.entities[0]?.mode,
    ).toBe('blank');
  });

  it('refuses a blank of the primary key', () => {
    expect(() =>
      subjectErasureOf(
        defineEntities({ p: { table: 'p', fields, primaryKey: ['name'], erasable: ['name'], erasure: { subjects: ['owner'] } } }),
      ),
    ).toThrow(/primary key/);
  });

  it('refuses an erasure on an entity with nothing erasable — it would reach nothing', () => {
    expect(() => subjectErasureOf(defineEntities({ p: { table: 'p', fields, erasure: { subjects: ['owner'] } } }))).toThrow(
      /no `erasable` fields/,
    );
  });

  it('refuses an empty subject list, and a subject that is not a field when the types are bypassed', () => {
    expect(() =>
      subjectErasureOf(defineEntities({ p: { table: 'p', fields, erasable: ['email'], erasure: { subjects: [] } } })),
    ).toThrow(/subjects is empty/);
    expect(() =>
      subjectErasureOf({ p: { table: 'p', fields, erasable: ['email'], erasure: { subjects: ['nobody'] } } }),
    ).toThrow(/'nobody', which is not a field/);
  });

  it('a subject column must be a field of the entity, at compile time', () => {
    defineEntities({
      // @ts-expect-error — 'nobody' is not a field of p
      p: { table: 'p', fields, erasable: ['email'], erasure: { subjects: ['nobody'] } },
    });
  });

  it('emits the declaration in model.json, mode spelled out and subjects sorted', () => {
    const model = emitModel(
      defineEntities({
        a: { table: 'a', fields, erasable: ['email'], erasure: { subjects: ['owner', 'id'] } },
        b: { table: 'b', fields, erasable: ['email'], erasure: { mode: 'custom' } },
        c: { table: 'c', fields, erasable: ['email'] },
      }),
    );
    expect(model.entities['a']?.erasure).toEqual({ mode: 'blank', subjects: ['id', 'owner'] });
    expect(model.entities['b']?.erasure).toEqual({ mode: 'custom' });
    expect(model.entities['c']?.erasure).toBeUndefined();
  });
});
