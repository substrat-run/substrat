/**
 * #1835 — the handler/declaration join, as a type the registration enforces.
 *
 * Like `typed-consumers.test.ts`, the `@ts-expect-error` lines ARE the feature: if a check stops
 * biting, `tsc` reports the directive unused and `pnpm --filter @substrat-run/kernel typecheck`
 * goes red. Each refusal has its positive twin beside it, so a check that refuses everything
 * cannot pass for one that refuses the right thing.
 */
import { describe, expect, it } from 'vitest';
import {
  operationConcurrencyOf,
  operationIdempotencyOptOutsOf,
  operationInputsOf,
  z,
} from '@substrat-run/contracts';
import {
  operationsFor,
  undeclaredOperations,
  type ModuleRegistration,
  type OperationHandler,
} from '../src/index.js';

const note = z.object({ id: z.string(), text: z.string() });

const notesOperations = {
  'notes/add': {
    permission: 'note:write',
    input: z.object({ text: z.string() }),
    output: note,
  },
  'notes/rename': {
    permission: 'note:write',
    input: z.object({ id: z.string(), text: z.string() }),
    output: note,
    concurrency: { over: 'note', idFrom: 'id' },
    idempotency: false,
  },
} as const;

const addOp = async (_ctx: unknown, input: { text: string }) => ({ id: 'n1', text: input.text });
const renameOp = async (_ctx: unknown, input: { id: string; text: string }) => ({ id: input.id, text: input.text });

const manifest = { id: 'notes', version: '0.1.0' } as unknown as ModuleRegistration['manifest'];

describe('operationsFor (#1835)', () => {
  it('binds an exact map, with the handler parameters typed from the declaration', () => {
    const bound = operationsFor(notesOperations)({
      'notes/add': async (_ctx, input) => ({ id: 'n1', text: input.text }),
      'notes/rename': renameOp,
    });
    const registration: ModuleRegistration = { manifest, ...bound };
    expect(Object.keys(registration.operations?.handlers ?? {})).toEqual(['notes/add', 'notes/rename']);
  });

  it('binds a named map as well as a literal', () => {
    const OPERATIONS = { 'notes/add': addOp, 'notes/rename': renameOp };
    expect(Object.keys(operationsFor(notesOperations)(OPERATIONS).operations.handlers)).toHaveLength(2);
  });

  it('refuses a declared operation with no handler', () => {
    // @ts-expect-error — 'notes/rename' is declared and not implemented
    operationsFor(notesOperations)({ 'notes/add': addOp });
  });

  it('refuses a handler no operation declares', () => {
    // @ts-expect-error — 'notes/remove' is not declared
    operationsFor(notesOperations)({ 'notes/add': addOp, 'notes/rename': renameOp, 'notes/remove': addOp });
    const OPERATIONS = { 'notes/add': addOp, 'notes/rename': renameOp, 'notes/remove': addOp };
    // @ts-expect-error — the same, through a named map, where no excess-property check applies
    operationsFor(notesOperations)(OPERATIONS);
  });

  it('refuses a handler whose input disagrees with the declaration', () => {
    operationsFor(notesOperations)({
      // @ts-expect-error — the declared input has no `title`
      'notes/add': async (_ctx: unknown, input: { title: string }) => ({ id: 'n1', text: input.title }),
      'notes/rename': renameOp,
    });
  });

  it('refuses a handler whose return disagrees with the declaration', () => {
    operationsFor(notesOperations)({
      // @ts-expect-error — the declared output is a note, not a number
      'notes/add': async () => 1,
      'notes/rename': renameOp,
    });
  });

  it('refuses an entry whose type was erased with a cast', () => {
    // @ts-expect-error — `as never` would otherwise pass every slot
    operationsFor(notesOperations)({ 'notes/add': addOp as never, 'notes/rename': renameOp });
    // @ts-expect-error — and so would `as any`
    operationsFor(notesOperations)({ 'notes/add': addOp as any, 'notes/rename': renameOp });
  });

  it('hands the host the inputs, concurrency and opt-outs of the SAME declaration', () => {
    const { operations: bound } = operationsFor(notesOperations)({ 'notes/add': addOp, 'notes/rename': renameOp });
    // The very object `operationInputsOf` returns carries the declared surface (#119) — and a
    // fresh call returns an equal one, so compare what the host reads, not identity.
    expect(Object.keys(bound.inputs ?? {})).toEqual(Object.keys(operationInputsOf(notesOperations)));
    expect(bound.concurrency).toEqual(operationConcurrencyOf(notesOperations));
    expect(bound.idempotencyOptOuts).toEqual(operationIdempotencyOptOutsOf(notesOperations));
    expect(bound.concurrency).toEqual({ 'notes/rename': { entity: 'note', idFrom: 'id' } });
    expect(bound.idempotencyOptOuts).toEqual(['notes/rename']);
    expect(() => bound.inputs?.['notes/add']?.parse({})).toThrow();
  });
});

describe('the registration field (#1835)', () => {
  it('refuses a plain object literal', () => {
    const registration: ModuleRegistration = {
      manifest,
      // @ts-expect-error — a hand-written map is not a BoundOperations
      operations: { 'notes/add': addOp as OperationHandler<never, unknown> },
    };
    expect(registration).toBeDefined();
  });

  it('refuses the derived maps handed over beside the handlers rather than with them', () => {
    const bound = operationsFor(notesOperations)({ 'notes/add': addOp, 'notes/rename': renameOp });
    const twin: ModuleRegistration = { manifest, ...bound };
    expect(twin.operations?.inputs).toBeDefined();
    const inputs = operationInputsOf(notesOperations);
    // @ts-expect-error — `operationInputs` is not a registration field: the schemas ride with the handlers
    const withInputs: ModuleRegistration = { manifest, ...undeclaredOperations('x', {}), operationInputs: inputs };
    // @ts-expect-error — nor is `operationConcurrency`
    const withConcurrency: ModuleRegistration = { manifest, ...bound, operationConcurrency: {} };
    // @ts-expect-error — nor `operationIdempotencyOptOuts`
    const withOptOuts: ModuleRegistration = { manifest, ...bound, operationIdempotencyOptOuts: [] };
    // A copy of the bound value is not one: the brand is an ES-private field, absent from a spread.
    const other = operationsFor({ 'notes/add': notesOperations['notes/add'] })({ 'notes/add': addOp });
    // @ts-expect-error — the schemas dropped after binding
    const dropped: ModuleRegistration = { manifest, operations: { ...bound.operations, inputs: undefined } };
    // @ts-expect-error — the handlers of one declaration with the schemas of another
    const mixed: ModuleRegistration = { manifest, operations: { ...bound.operations, inputs: other.operations.inputs } };
    const added: ModuleRegistration = {
      manifest,
      // @ts-expect-error — a handler added after binding, with no schema behind it
      operations: { ...bound.operations, handlers: { ...bound.operations.handlers, 'notes/remove': addOp } },
    };
    expect([dropped, mixed, added]).toHaveLength(3);
    // @ts-expect-error — and the bound value cannot be assembled by hand either
    const assembled: ModuleRegistration = { manifest, operations: { handlers: {}, inputs } };
    expect([withInputs, withConcurrency, withOptOuts, assembled]).toHaveLength(4);
  });

  it('accepts the declared exception, which must give its reason', () => {
    const registration: ModuleRegistration = {
      manifest,
      ...undeclaredOperations('a fixture with no declared surface', { 'notes/add': addOp }),
    };
    expect(Object.keys(registration.operations?.handlers ?? {})).toEqual(['notes/add']);
    expect(registration.operations?.inputs).toBeUndefined();
    expect(() => undeclaredOperations('  ', { 'notes/add': addOp })).toThrow(/reason/);
  });
});
