/**
 * #811 / #2436 — a read that answers with a whole table must say it is a page, however the
 * output is wrapped. The gate used to ask `instanceof ZodArray` of the declared output, so an
 * array under `.nullable()` and friends, or behind `z.custom()`, was never refused.
 */
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { defineEntities } from '../src/model.js';
import { defineOperations } from '../src/operations.js';

const entities = defineEntities({
  thing: { table: 't_thing', fields: z.object({ id: z.string(), name: z.string() }) },
});
const define = defineOperations(entities, ['thing:read'] as const);
const entry = z.object({ id: z.string(), name: z.string() });
const arr = z.array(entry);

/** A list read declaring `output`, with or without `paged`. */
const list = (output: unknown, paged?: unknown) =>
  define({
    'thing/list': {
      summary: 's',
      permission: 'thing:read',
      // The cast is the point: the gate must hold for an operations object built around the types.
      output: output as typeof entry,
      ...(paged === undefined ? {} : { paged: paged as { sortKey: 'id' } }),
    },
  });

const BARE = /returns a bare array and does not declare `paged`/;
const WRAPPED = /returns an array \(under [a-z > ]+\) and does not declare `paged`/;
const OPAQUE = /declares an opaque output, .* and does not declare `paged`/;
const CONTAINER = /returns a [a-z ]+ .*and does not declare `paged`/;
const REMEDY = /declare the real entry schema as `output`, or add `paged`/;

describe('assertListsArePaged', () => {
  it('refuses a bare top-level array, in the bare-array words', () => {
    expect(() => list(arr)).toThrow(BARE);
  });

  it('refuses an array under each wrapper, naming the wrapper rather than calling it bare', () => {
    for (const wrapped of [
      arr.optional(),
      arr.nullable(),
      arr.nullish(),
      arr.default([]),
      arr.prefault([]),
      arr.readonly(),
      arr.catch([]),
      arr.optional().nonoptional(),
      z.lazy(() => arr),
      arr.pipe(z.array(entry)),
    ]) {
      expect(() => list(wrapped)).toThrow(WRAPPED);
      expect(() => list(wrapped)).not.toThrow(BARE);
    }
    expect(() => list(arr.nullable())).toThrow(/under nullable\)/);
  });

  it('refuses an array under several wrappers at once', () => {
    expect(() => list(z.lazy(() => arr.nullable().readonly()).optional())).toThrow(/under optional > lazy > readonly > nullable\)/);
  });

  it('opens a union: `array.or(null)` is `.nullable()`', () => {
    expect(() => list(arr.or(z.null()))).toThrow(WRAPPED);
    expect(() => list(z.union([entry, arr]))).toThrow(WRAPPED);
    expect(() => list(z.union([z.null(), z.union([entry, arr.optional()])]))).toThrow(WRAPPED);
    expect(() =>
      list(z.discriminatedUnion('kind', [z.object({ kind: z.literal('a') }), z.object({ kind: z.literal('b') })])),
    ).not.toThrow();
  });

  it('opens an intersection on either side', () => {
    expect(() => list(arr.and(arr))).toThrow(WRAPPED);
    expect(() => list(entry.and(arr as never))).toThrow(WRAPPED);
    expect(() => list(arr.and(entry as never))).toThrow(WRAPPED);
    expect(() => list(entry.and(z.object({ extra: z.string() })))).not.toThrow();
  });

  it('judges a pipe at its OUT side: what the handler returns is the transformed value', () => {
    // the out side is the array: refused
    expect(() => list(z.unknown().pipe(arr))).toThrow(WRAPPED);
    expect(() => list(z.string().transform((s) => [s]).pipe(z.array(z.string())))).toThrow(WRAPPED);
    // the in side is an array but the operation answers with an object: admitted
    expect(() => list(arr.pipe(entry as never))).not.toThrow();
    expect(() => list(z.unknown().pipe(entry))).not.toThrow();
  });

  it('refuses a transform as opaque, whichever way it points', () => {
    // a transform's output is unknowable: it may be a count, or the table
    expect(() => list(arr.transform((rows) => rows.length))).toThrow(OPAQUE);
    expect(() => list(entry.transform((o) => [o]))).toThrow(OPAQUE);
    expect(() => list(z.transform((x) => x))).toThrow(OPAQUE);
    expect(() => list(arr.transform((rows) => rows.length))).toThrow(REMEDY);
  });

  it('refuses each opaque output, with one remedy, and names z.instanceof as what it is', () => {
    expect(() => list(z.custom<unknown[]>())).toThrow(OPAQUE);
    expect(() => list(z.custom<unknown[]>())).toThrow(REMEDY);
    expect(() => list(z.any())).toThrow(/opaque output, `z\.any\(\)`/);
    expect(() => list(z.unknown())).toThrow(/opaque output, `z\.unknown\(\)`/);
    expect(() => list(z.instanceof(Map))).toThrow(/`z\.custom\(\)` \(or `z\.instanceof\(\)`\)/);
    expect(() => list(z.json())).toThrow(WRAPPED); // z.json() is a lazy union that contains arrays
  });

  it('refuses an opaque output under a wrapper or in a union', () => {
    expect(() => list(z.custom<unknown[]>().nullable())).toThrow(/under nullable\)/);
    expect(() => list(z.lazy(() => z.custom<unknown[]>()))).toThrow(OPAQUE);
    expect(() => list(z.union([entry, z.unknown()]))).toThrow(OPAQUE);
  });

  it('refuses an unbounded container: record, map, set, promise, tuple with a rest', () => {
    expect(() => list(z.record(z.string(), entry))).toThrow(/returns a record /);
    expect(() => list(z.map(z.string(), entry))).toThrow(/returns a map /);
    expect(() => list(z.set(z.string()))).toThrow(/returns a set /);
    expect(() => list(z.promise(arr))).toThrow(/returns a promise /);
    expect(() => list(z.tuple([z.string()]).rest(z.string()))).toThrow(/returns a tuple with a rest element /);
    expect(() => list(z.record(z.string(), entry).nullable())).toThrow(CONTAINER);
    expect(() => list(z.tuple([z.string(), z.number()]))).not.toThrow();
  });

  it('terminates on a lazy schema that refers to itself', () => {
    const self: z.ZodType = z.lazy(() => self);
    expect(() => list(self)).not.toThrow();
    const arrayInCycle: z.ZodType = z.lazy(() => z.union([arrayInCycle, arr]));
    expect(() => list(arrayInCycle)).toThrow(WRAPPED);
  });

  it('gives up on a lazy factory that returns a fresh schema every call, with its own words', () => {
    const fresh = (): z.ZodType => z.lazy(fresh);
    expect(() => list(fresh())).toThrow(/schema too deep to judge/);
    expect(() => list(fresh())).toThrow(REMEDY);
  });

  it('gives up on a union of fresh lazies that fans out instead of deepening', () => {
    const fan = (): z.ZodType => z.union([z.lazy(fan), z.lazy(fan)]);
    expect(() => list(fan())).toThrow(/schema too deep to judge/);
  });

  it('reports a lazy whose getter throws as that, not as z.custom', () => {
    const getter = () =>
      list(
        z.lazy(() => {
          throw new Error('not initialised');
        }),
      );
    expect(getter).toThrow(/a `z\.lazy\(\)` whose getter throws at declaration/);
    expect(getter).not.toThrow(/z\.custom/);
  });

  it('admits each of those once `paged` is declared', () => {
    const paged = { sortKey: 'id' };
    for (const output of [
      arr.nullable(),
      z.lazy(() => arr),
      arr.or(z.null()),
      z.custom<unknown[]>(),
      z.unknown(),
      arr.transform((rows) => rows.length),
      z.record(z.string(), entry),
    ]) {
      expect(() => list(output, paged)).not.toThrow();
    }
  });

  it('leaves an object, a nested array and a wrapped object alone', () => {
    expect(() => list(entry)).not.toThrow();
    expect(() => list(entry.nullable())).not.toThrow();
    expect(() => list(entry.optional().readonly())).not.toThrow();
    expect(() => list(z.object({ ids: z.array(z.string()) }))).not.toThrow();
    expect(() => list(z.lazy(() => entry))).not.toThrow();
    expect(() => list(z.union([entry, z.null()]))).not.toThrow();
  });
});
