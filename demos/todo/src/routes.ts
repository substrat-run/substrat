/**
 * The HTTP surface — one line of mounting and what is left of an error map.
 *
 * There is no route table here. Method, path and which input fields the path
 * carries are declared on the operations themselves and compile-checked there,
 * so `mountOperations` derives the table at mount time. Callout's hand-written
 * equivalent is 164 lines, and it had already drifted from its own declarations.
 */
import type { Context, Hono } from 'hono';
import { HTTPException } from 'hono/http-exception';
import { mountOperations, type ResolveStub } from '@substrat-run/vertical-host';
import { todoOperations } from '../spec/model.js';

export type { ResolveStub };

export function mountApi(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  app: Hono<any, any, any>,
  resolveStub: ResolveStub,
): { operation: string; method: string; path: string }[] {
  // The mount decides the STATUS for everything the kernel itself names — a
  // refused permission, an input that failed to parse, `resolveStub` refusing an
  // anonymous call — and re-throws the rest untouched (#791). So what is left
  // here is this vertical's own vocabulary, plus the `{ error }` body it wants on
  // every failure: the mount deliberately does not pick a body for you.
  app.onError((err, c: Context) => {
    if (err instanceof HTTPException) return c.json({ error: err.message }, err.status);
    if (/unknown operation|not entitled|nobody here/.test(err.message)) {
      return c.json({ error: err.message }, 404);
    }
    return c.json({ error: err.message }, 400);
  });

  return mountOperations(app, todoOperations, resolveStub);
}
