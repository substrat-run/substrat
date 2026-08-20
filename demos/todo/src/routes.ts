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
  // anonymous call — and re-throws the rest untouched (#791).
  //
  // Since #113 that includes every throw carrying a taxonomy code, and this
  // vertical's own refusals all carry one: `classifyError` reads the code by shape
  // and re-throws an `HTTPException` at the right status, which the first line
  // below turns into this app's `{ error }` body. Matching on our own error PROSE
  // is what that replaced — the strings moved and the statuses silently followed.
  app.onError((err, c: Context) => {
    if (err instanceof HTTPException) return c.json({ error: err.message }, err.status);
    // What is left is PLATFORM vocabulary the mount still has no opinion on: an
    // operation nobody declared, and a feature this tenant does not hold. 404 for
    // the second deliberately — a 403 would confirm the feature exists.
    if (/unknown operation|not entitled/.test(err.message)) {
      return c.json({ error: err.message }, 404);
    }
    return c.json({ error: err.message }, 400);
  });

  return mountOperations(app, todoOperations, resolveStub);
}
