/**
 * #959 — engine-invoicing's handlers are bound to its declared operations, as a
 * compile-time suite.
 *
 * `src/index.ts` writes its handler map `satisfies OperationHandlersFor<typeof
 * invoicingOperations>`, so each handler's input and output are DERIVED from the declaration
 * instead of cast away. A type-level check fails permissively — one that has stopped
 * biting compiles exactly like one that still does — so every `@ts-expect-error`
 * below is load-bearing in the inverted direction: if the binding stops rejecting a
 * wrong handler, `tsc` reports the directive unused and
 * `pnpm --filter @substrat-run/engine-invoicing typecheck` goes red. Each negative has a
 * positive twin through the same type, because a negative alone passes just as well
 * when nothing is left to accept anything.
 *
 * What a test cannot see is whether `src/index.ts` still CARRIES the clause: deleting
 * it compiles. That half is `lint:module-inputs`, which refuses an engine map that
 * is not bound, or has an entry cast.
 */
import { describe, expect, it } from 'vitest';
import type { HandlerInput, HandlerOutput } from '@substrat-run/contracts';
import type { OperationHandlersFor } from '@substrat-run/kernel';

import { invoicingModule, invoicingOperations } from '../src/index.js';

type Ops = typeof invoicingOperations;
type Handlers = OperationHandlersFor<Ops>;
type In<K extends keyof Ops> = HandlerInput<Ops[K]>;
type Out<K extends keyof Ops> = HandlerOutput<Ops[K]>;

/** A value of the type asked for. Only ever inside a handler nothing calls. */
declare function declared<T>(): T;

// --- a paged read answers its Page, not the bare list (#811) ------------------
export const pagedOk: Handlers['invoicing/list'] = async () => declared<Out<'invoicing/list'>>();
// @ts-expect-error 'invoicing/list' is paged: the handler returns a Page, not its entries
export const pagedBare: Handlers['invoicing/list'] = async () => declared<Out<'invoicing/list'>['entries']>();

// --- a read that declares one object returns one object, not a list of them ---
export const singleOk: Handlers['invoicing/get'] = async () => declared<Out<'invoicing/get'>>();
// @ts-expect-error 'invoicing/get' declares one object, and a list of them is not it
export const singleList: Handlers['invoicing/get'] = async () => declared<Out<'invoicing/get'>[]>();

// --- a handler needs no more of its input than the host parses ----------------
export const inputOk: Handlers['invoicing/get'] = async (_ctx, input: In<'invoicing/get'>) => {
  void input;
  return declared<Out<'invoicing/get'>>();
};
// @ts-expect-error 'undeclared' is not in the declared input, so the host never parsed it
export const inputUndeclared: Handlers['invoicing/get'] = async (
  _ctx,
  input: In<'invoicing/get'> & { undeclared: string },
) => {
  void input;
  return declared<Out<'invoicing/get'>>();
};

describe('#959 engine-invoicing handler binding', () => {
  it('registers exactly one handler per declared operation', () => {
    expect(Object.keys(invoicingModule.operations ?? {}).sort()).toEqual(Object.keys(invoicingOperations).sort());
  });
});
