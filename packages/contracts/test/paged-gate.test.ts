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
const OPAQUE = /opaque `z\.custom` output/;

describe('assertListsArePaged', () => {
  it('refuses a bare top-level array', () => {
    expect(() => list(z.array(entry))).toThrow(BARE);
  });

  it('refuses an array under each wrapper', () => {
    const arr = z.array(entry);
    expect(() => list(arr.optional())).toThrow(BARE);
    expect(() => list(arr.nullable())).toThrow(BARE);
    expect(() => list(arr.nullish())).toThrow(BARE);
    expect(() => list(arr.default([]))).toThrow(BARE);
    expect(() => list(arr.prefault([]))).toThrow(BARE);
    expect(() => list(arr.readonly())).toThrow(BARE);
    expect(() => list(arr.catch([]))).toThrow(BARE);
    expect(() => list(arr.optional().nonoptional())).toThrow(BARE);
    expect(() => list(z.lazy(() => arr))).toThrow(BARE);
    expect(() => list(arr.pipe(z.array(entry)))).toThrow(BARE);
    expect(() => list(arr.transform((rows) => rows.length))).toThrow(BARE);
  });

  it('refuses an array under several wrappers at once', () => {
    expect(() => list(z.lazy(() => z.array(entry).nullable().readonly()).optional())).toThrow(BARE);
  });

  it('refuses an array on the far side of a pipe', () => {
    expect(() => list(z.string().transform((s) => [s]).pipe(z.array(z.string())))).toThrow(BARE);
  });

  it('refuses an opaque z.custom output, naming the remedy', () => {
    expect(() => list(z.custom<unknown[]>())).toThrow(OPAQUE);
    expect(() => list(z.custom<unknown[]>())).toThrow(/declare the real schema as `output`/);
  });

  it('refuses a z.custom output under a wrapper', () => {
    expect(() => list(z.custom<unknown[]>().nullable())).toThrow(OPAQUE);
    expect(() => list(z.lazy(() => z.custom<unknown[]>()))).toThrow(OPAQUE);
  });

  it('terminates on a lazy schema that refers to itself', () => {
    const self: z.ZodType = z.lazy(() => self);
    expect(() => list(self)).not.toThrow();
    const arrayInCycle: z.ZodType = z.lazy(() => z.union([arrayInCycle, z.array(entry)]));
    // a union is not unwrapped: the walk must still end, with no verdict on it
    expect(() => list(arrayInCycle)).not.toThrow();
  });

  it('refuses a lazy whose getter throws, rather than passing what it cannot read', () => {
    expect(() =>
      list(
        z.lazy(() => {
          throw new Error('not initialised');
        }),
      ),
    ).toThrow(OPAQUE);
  });

  it('admits each of those once `paged` is declared', () => {
    const paged = { sortKey: 'id' };
    expect(() => list(z.array(entry).nullable(), paged)).not.toThrow();
    expect(() => list(z.lazy(() => z.array(entry)), paged)).not.toThrow();
    expect(() => list(z.custom<unknown[]>(), paged)).not.toThrow();
  });

  it('leaves an object, a nested array and a wrapped object alone', () => {
    expect(() => list(entry)).not.toThrow();
    expect(() => list(entry.nullable())).not.toThrow();
    expect(() => list(entry.optional().readonly())).not.toThrow();
    expect(() => list(z.object({ ids: z.array(z.string()) }))).not.toThrow();
    expect(() => list(z.lazy(() => entry))).not.toThrow();
  });
});
