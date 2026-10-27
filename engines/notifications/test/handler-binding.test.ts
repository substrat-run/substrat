/**
 * #959 — the handlers are bound to the declared operations, as a compile-time suite. Every
 * `@ts-expect-error` is load-bearing: if the binding stops refusing a wrong handler, `tsc`
 * reports the directive unused and typecheck goes red. Each negative has a positive twin.
 */
import { handlerBindingSuite } from '@substrat-run/engine-test-kit/suites';
import type { HandlerInput, HandlerOutput, OperationImpl } from '@substrat-run/contracts';
import type { OperationContext } from '@substrat-run/kernel';
import { notificationsModule, notificationsOperations } from '../src/index.js';

type Ops = typeof notificationsOperations;
type Handlers = OperationImpl<Ops, OperationContext>;
type In<K extends keyof Ops> = HandlerInput<Ops[K]>;
type Out<K extends keyof Ops> = HandlerOutput<Ops[K]>;

declare function declared<T>(): T;

// --- a paged read answers its Page, not the bare list (#811) ------------------
export const pagedOk: Handlers['notifications/list-deliveries'] = async () => declared<Out<'notifications/list-deliveries'>>();
// @ts-expect-error 'notifications/list-deliveries' is paged: the handler returns a Page
export const pagedBare: Handlers['notifications/list-deliveries'] = async () => declared<Out<'notifications/list-deliveries'>['entries']>();

// --- the preference writes take no principal: they act on the caller ---------
export const selfOk: Handlers['notifications/set-my-address'] = async (_ctx, input: In<'notifications/set-my-address'>) => {
  void input;
  return declared<Out<'notifications/set-my-address'>>();
};
// @ts-expect-error 'principal' is not in the declared input: nobody may set another person's address
export const selfOther: Handlers['notifications/set-my-address'] = async (
  _ctx,
  input: In<'notifications/set-my-address'> & { principal: string },
) => {
  void input;
  return declared<Out<'notifications/set-my-address'>>();
};

handlerBindingSuite('notifications', notificationsModule, notificationsOperations);
