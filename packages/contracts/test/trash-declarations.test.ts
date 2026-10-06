/**
 * #119 PR 2 — `trashed` on an operation, `trash.purgeAfterDays` on an entity, and what the
 * platform derives from them: the host's targets, the purge schedule, and the gaps.
 *
 * The `@ts-expect-error` cases ARE the compile-time half: if one stops biting, tsc reports the
 * directive unused and the package's typecheck goes red. Each has a load-time twin, because an
 * operations object built around the types (a cast) must not get past either.
 */
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { defineEntities } from '../src/model.js';
import {
  defineOperations,
  operationTargetsOf,
  PURGE_CADENCE_MINUTES,
  purgeSchedulesOf,
  trashRefusalGapsOf,
} from '../src/operations.js';

const entities = defineEntities({
  box: {
    table: 't_box',
    fields: z.object({ id: z.string(), name: z.string() }),
    trash: { permission: 'box:trash', purgeAfterDays: 14 },
  },
  shelf: { table: 't_shelf', fields: z.object({ id: z.string() }) },
});
const PERMS = ['box:read', 'box:trash', 'box:delete'] as const;
const ok = z.object({ ok: z.boolean() });
const byBox = z.object({ boxId: z.string() });
/** A purge's input: the id, strict. */
const purgeInput = z.strictObject({ boxId: z.string() });
const define = defineOperations(entities, PERMS);

const ops = define({
  'b/rename': { summary: 's', permission: { key: 'box:read', entity: 'box', idFrom: 'boxId' }, input: byBox, output: ok },
  'b/restore': {
    summary: 's',
    permission: { key: 'box:trash', entity: 'box', idFrom: 'boxId' },
    trashed: 'admits',
    input: byBox,
    output: ok,
  },
  'b/delete': {
    summary: 's',
    permission: { key: 'box:delete', entity: 'box', idFrom: 'boxId' },
    trashed: 'purges',
    input: purgeInput,
    output: ok,
  },
  'b/touch': {
    summary: 's',
    permission: { key: 'box:read', entity: 'box', resolved: 'the box the thing is in' },
    input: z.object({ thingId: z.string() }),
    output: ok,
  },
  'b/list': { summary: 's', permission: 'box:read', output: ok },
});

describe('the compile-time rule', () => {
  it('admits `trashed` only on an idFrom check over an entity that declares trash', () => {
    expect(() =>
      define({
        'x/a': {
          summary: 's',
          permission: { key: 'box:read', entity: 'shelf', idFrom: 'id' },
          // @ts-expect-error 'shelf' declares no trash — there is nothing to opt out of
          trashed: 'admits',
          input: z.object({ id: z.string() }),
          output: ok,
        },
      }),
    ).toThrow(/declares `trash`/);
  });

  it('refuses it on a node-level check and on a resolved one', () => {
    expect(() =>
      define({
        // @ts-expect-error a node-level check names no entity for the host to read
        'x/node': { summary: 's', permission: 'box:read', trashed: 'admits', output: ok },
      }),
    ).toThrow(/trashed/);
    expect(() =>
      define({
        'x/resolved': {
          summary: 's',
          permission: { key: 'box:read', entity: 'box', resolved: 'r' },
          // @ts-expect-error a resolved check names no input field for the host to read
          trashed: 'admits',
          input: z.object({ thingId: z.string() }),
          output: ok,
        },
      }),
    ).toThrow(/trashed/);
  });

  it('refuses a value that is neither, at load time too', () => {
    expect(() =>
      define({
        'x/bad': {
          summary: 's',
          permission: { key: 'box:read', entity: 'box', idFrom: 'boxId' },
          // @ts-expect-error only 'admits' or 'purges'
          trashed: 'allows',
          input: byBox,
          output: ok,
        },
      }),
    ).toThrow(/'admits' or 'purges'/);
  });
});

describe('purges', () => {
  it('is one operation per entity', () => {
    const del = { summary: 's', permission: { key: 'box:delete', entity: 'box', idFrom: 'boxId' }, trashed: 'purges', input: purgeInput, output: ok } as const;
    expect(() => define({ 'x/one': del, 'x/two': del })).toThrow(/one permanent delete per entity/);
  });

  it('takes the id and nothing else — not even an optional field, so a purge reaches only its entity', () => {
    expect(() =>
      define({
        'x/del': {
          summary: 's',
          permission: { key: 'box:delete', entity: 'box', idFrom: 'boxId' },
          // @ts-expect-error a required second field is not a purge's input
          trashed: 'purges',
          input: z.object({ boxId: z.string(), reason: z.string() }),
          output: ok,
        },
      }),
    ).toThrow(/and nothing else/);
    expect(() =>
      define({
        'x/del': {
          summary: 's',
          permission: { key: 'box:delete', entity: 'box', idFrom: 'boxId' },
          // @ts-expect-error nor is an optional second id — it would let the purge reach another entity
          trashed: 'purges',
          input: z.object({ boxId: z.string(), otherBoxId: z.string().optional() }),
          output: ok,
        },
      }),
    ).toThrow(/and nothing else/);
    // Twin: the same input under 'admits' compiles and loads.
    define({
      'x/del': {
        summary: 's',
        permission: { key: 'box:delete', entity: 'box', idFrom: 'boxId' },
        // 'admits' is still fine — only a purge is held to the id alone.
        trashed: 'admits',
        input: z.object({ boxId: z.string(), otherBoxId: z.string().optional() }),
        output: ok,
      },
    });
  });

  it('takes a STRICT object — a passthrough one keeps an extra id through the parse, a default one drops it silently', () => {
    const purge = (input: z.ZodObject) =>
      define({ 'x/del': { summary: 's', permission: { key: 'box:delete', entity: 'box', idFrom: 'boxId' }, trashed: 'purges', input, output: ok } });
    for (const input of [z.looseObject({ boxId: z.string() }), z.object({ boxId: z.string() }).passthrough(), z.object({ boxId: z.string() })]) {
      expect(() => purge(input)).toThrow(/strict/);
    }
    // Twin: strict, by either spelling.
    purge(z.strictObject({ boxId: z.string() }));
    purge(z.object({ boxId: z.string() }).strict());
  });
});

describe('operationTargetsOf', () => {
  it('names every idFrom-addressed operation, its key and its opt-in — and nothing else', () => {
    expect(operationTargetsOf(ops)).toEqual({
      'b/rename': { entity: 'box', idFrom: 'boxId', key: 'box:read' },
      'b/restore': { entity: 'box', idFrom: 'boxId', key: 'box:trash', trashed: 'admits' },
      'b/delete': { entity: 'box', idFrom: 'boxId', key: 'box:delete', trashed: 'purges' },
    });
  });
});

describe('purgeSchedulesOf', () => {
  it('derives one schedule per horizon: the purging operation, hourly, holding exactly its key', () => {
    expect(purgeSchedulesOf(ops, entities)).toEqual([
      {
        operation: 'b/delete',
        cadence: { everyMinutes: PURGE_CADENCE_MINUTES },
        permissions: ['box:delete'],
        purge: { entityType: 'box' },
      },
    ]);
    expect(PURGE_CADENCE_MINUTES).toBe(60);
  });

  it('refuses a horizon with no purging operation', () => {
    const { 'b/delete': _, ...rest } = ops;
    expect(() => purgeSchedulesOf(rest, entities)).toThrow(/nothing to run/);
  });

  it('derives nothing for an entity with no horizon', () => {
    const noHorizon = { ...entities, box: { ...entities.box, trash: { permission: 'box:trash' } } };
    expect(purgeSchedulesOf(ops, noHorizon)).toEqual([]);
  });
});

describe('trashRefusalGapsOf', () => {
  it('names the operations whose check is resolved on a trashable entity, and only those', () => {
    expect(trashRefusalGapsOf(ops, entities)).toEqual([{ operation: 'b/touch', entity: 'box' }]);
  });
});
