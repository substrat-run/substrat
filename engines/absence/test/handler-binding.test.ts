/**
 * #959 — engine-absence's handlers are bound to its declared operations, as a
 * compile-time suite.
 *
 * `src/index.ts` binds its handler map with `operationsFor(absenceOperations)(…)`, so
 * each handler's input and output are DERIVED from the declaration instead of
 * cast away. A type-level check fails permissively — one that has stopped biting
 * compiles exactly like one that still does — so every `@ts-expect-error` below
 * is load-bearing in the inverted direction: if the binding stops rejecting a
 * wrong handler, `tsc` reports the directive unused and
 * `pnpm --filter @substrat-run/engine-absence typecheck` goes red. Each negative has a
 * positive twin through the same type, because a negative alone passes just as well
 * when nothing is left to accept anything.
 *
 * That `src/index.ts` binds at all is a type too (#1835): the registration takes only a
 * `BoundOperations`, which the binder produces, and boundary-lint R11 refuses the one
 * spelling a type cannot see — a cast of the whole map.
 */
import { describe, expect, it } from 'vitest';
import type { HandlerInput, HandlerOutput, OperationImpl } from '@substrat-run/contracts';
import type { OperationContext } from '@substrat-run/kernel';

import { absenceModule, absenceOperations } from '../src/index.js';

type Ops = typeof absenceOperations;
type Handlers = OperationImpl<Ops, OperationContext>;
type In<K extends keyof Ops> = HandlerInput<Ops[K]>;
type Out<K extends keyof Ops> = HandlerOutput<Ops[K]>;

/** A value of the type asked for. Only ever inside a handler nothing calls. */
declare function declared<T>(): T;

// --- a paged read answers its Page, not the bare list (#811) ------------------
export const pagedOk: Handlers['absence/list-requests'] = async () => declared<Out<'absence/list-requests'>>();
// @ts-expect-error 'absence/list-requests' is paged: the handler returns a Page, not its entries
export const pagedBare: Handlers['absence/list-requests'] = async () => declared<Out<'absence/list-requests'>['entries']>();

// --- an operation declaring one object returns one object, not a list of them -
export const singleOk: Handlers['absence/request'] = async () => declared<Out<'absence/request'>>();
// @ts-expect-error 'absence/request' declares one object, and a list of them is not it
export const singleList: Handlers['absence/request'] = async () => declared<Out<'absence/request'>[]>();

// --- a handler needs no more of its input than the host parses ----------------
export const inputOk: Handlers['absence/request'] = async (_ctx, input: In<'absence/request'>) => {
  void input;
  return declared<Out<'absence/request'>>();
};
// @ts-expect-error 'undeclared' is not in the declared input, so the host never parsed it
export const inputUndeclared: Handlers['absence/request'] = async (
  _ctx,
  input: In<'absence/request'> & { undeclared: string },
) => {
  void input;
  return declared<Out<'absence/request'>>();
};

describe('#959 engine-absence handler binding', () => {
  it('registers exactly one handler per declared operation', () => {
    expect(Object.keys(absenceModule.operations?.handlers ?? {}).sort()).toEqual(Object.keys(absenceOperations).sort());
  });
});
