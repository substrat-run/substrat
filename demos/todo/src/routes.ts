/**
 * The HTTP surface — an error map and one line of mounting.
 *
 * There is no route table here. Method, path and which input fields the path
 * carries are declared on the operations themselves and compile-checked there,
 * so `mountOperations` derives the table at mount time. Callout's hand-written
 * equivalent is 164 lines, and it had already drifted from its own declarations.
 */
import type { Context, Hono } from 'hono';
import { HTTPException } from 'hono/http-exception';
import { PermissionDenied } from '@substrat-run/kernel';
import { mountOperations, type ResolveStub } from '@substrat-run/vertical-host';
import { todoOperations } from '../spec/model.js';

export type { ResolveStub };

export function mountApi(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  app: Hono<any, any, any>,
  resolveStub: ResolveStub,
): { operation: string; method: string; path: string }[] {
  // Shared mapping: auth is the transport's (401), a refused permission is the
  // kernel's (403), a missing thing is 404, anything else is a bad request.
  app.onError((err, c: Context) => {
    if (err instanceof HTTPException) return err.getResponse();
    if (err instanceof PermissionDenied) return c.json({ error: err.message }, 403);
    if (/not found|unknown scope|unknown operation|not entitled|nobody here/.test(err.message)) {
      return c.json({ error: err.message }, 404);
    }
    return c.json({ error: err.message }, 400);
  });

  return mountOperations(app, todoOperations, resolveStub);
}
