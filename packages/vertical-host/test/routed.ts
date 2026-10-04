/**
 * #1923: a routed request as the field walk's suites need it — the router's signature and
 * node, the arming header beside them, and the real stamp in front of an app.
 */
import { FIELD_COVERAGE_ARMED, FIELD_COVERAGE_HEADER } from '@substrat-run/contracts';
import type { Hono } from 'hono';
import { invocationLog, INVOCATION_RECORD_KEY, type InvocationRecord } from '../src/invocation-log.js';

/** The router's shared secret, as the test worker holds it. */
export const ROUTER_SECRET = 'router-sekret';

/** The headers the router asserts on every dispatched request, signature included. */
export const routed: Record<string, string> = {
  'x-substrat-router': ROUTER_SECRET,
  'x-substrat-tenant': '01JZ0000000000000000TEN001',
  'x-substrat-scope': '01JZ0000000000000000SCP001',
  'x-substrat-vertical': 'acme/widgets',
  'x-substrat-surface': 'app',
};

/** What the router sends on a sampled request: the arming header beside a signed node. */
export const ARMED: Record<string, string> = { ...routed, [FIELD_COVERAGE_HEADER]: FIELD_COVERAGE_ARMED };

/** The bindings the stamp reads the secret from. */
export const ENV = { ROUTER_SECRET };

/**
 * Mount the real stamp, which decides whether the router armed the walk, then swap the record
 * it hands down for `record`, which the test holds.
 */
export function stampInto(app: Hono<{ Bindings: typeof ENV }>, record: InvocationRecord): void {
  app.use('*', invocationLog<typeof ENV>({ routerSecret: (env) => env.ROUTER_SECRET }));
  app.use('*', async (c, next) => {
    (c as unknown as { set: (k: string, v: unknown) => void }).set(INVOCATION_RECORD_KEY, record);
    await next();
  });
}

/** Run `fn` with the stamp's own invocation lines kept off the console. */
export async function quietly<T>(fn: () => Promise<T>): Promise<T> {
  const original = console.log;
  console.log = (first: unknown, ...rest: unknown[]) => {
    if (typeof first === 'string' && first.includes('"substrat":"invocation"')) return;
    original(first, ...rest);
  };
  try {
    return await fn();
  } finally {
    console.log = original;
  }
}
