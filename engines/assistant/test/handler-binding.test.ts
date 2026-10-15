/**
 * #959 — engine-assistant's handlers are bound to its declared operations, as a compile-time
 * suite.
 *
 * `src/index.ts` binds its handler map with `operationsFor(assistantOperations)(…)`, so each
 * handler's input and output are DERIVED from the declaration instead of cast away. A
 * type-level check fails permissively — one that has stopped biting compiles exactly like one
 * that still does — so every `@ts-expect-error` below is load-bearing in the inverted
 * direction: if the binding stops rejecting a wrong handler, `tsc` reports the directive
 * unused and `pnpm --filter @substrat-run/engine-assistant typecheck` goes red. Each negative
 * has a positive twin through the same type.
 */
import { describe, expect, it } from 'vitest';
import type { HandlerInput, HandlerOutput, OperationImpl } from '@substrat-run/contracts';
import type { OperationContext } from '@substrat-run/kernel';

import { assistantModule, assistantOperations } from '../src/index.js';

type Ops = typeof assistantOperations;
type Handlers = OperationImpl<Ops, OperationContext>;
type In<K extends keyof Ops> = HandlerInput<Ops[K]>;
type Out<K extends keyof Ops> = HandlerOutput<Ops[K]>;

/** A value of the type asked for. Only ever inside a handler nothing calls. */
declare function declared<T>(): T;

// --- a paged read answers its Page, not the bare list (#811) ------------------
export const pagedOk: Handlers['assistant/list-threads'] = async () => declared<Out<'assistant/list-threads'>>();
// @ts-expect-error 'assistant/list-threads' is paged: the handler returns a Page, not its entries
export const pagedBare: Handlers['assistant/list-threads'] = async () => declared<Out<'assistant/list-threads'>['entries']>();

// --- an operation declaring one object returns one object, not a list of them -
export const singleOk: Handlers['assistant/create-thread'] = async () => declared<Out<'assistant/create-thread'>>();
// @ts-expect-error 'assistant/create-thread' declares one object, and a list of them is not it
export const singleList: Handlers['assistant/create-thread'] = async () => declared<Out<'assistant/create-thread'>[]>();

// --- a handler needs no more of its input than the host parses ----------------
export const inputOk: Handlers['assistant/send-message'] = async (_ctx, input: In<'assistant/send-message'>) => {
  void input;
  return declared<Out<'assistant/send-message'>>();
};
// @ts-expect-error 'undeclared' is not in the declared input, so the host never parsed it
export const inputUndeclared: Handlers['assistant/send-message'] = async (
  _ctx,
  input: In<'assistant/send-message'> & { undeclared: string },
) => {
  void input;
  return declared<Out<'assistant/send-message'>>();
};

describe('#959 engine-assistant handler binding', () => {
  it('registers exactly one handler per declared operation', () => {
    expect(Object.keys(assistantModule.operations?.handlers ?? {}).sort()).toEqual(Object.keys(assistantOperations).sort());
  });
});
