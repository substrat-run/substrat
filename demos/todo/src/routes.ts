/**
 * The HTTP surface — one line of mounting, and an error map that is now one line too.
 *
 * There is no route table here. Method, path and which input fields the path
 * carries are declared on the operations themselves and compile-checked there,
 * so `mountOperations` derives the table at mount time. Callout's hand-written
 * equivalent is 164 lines, and it had already drifted from its own declarations.
 */
import type { Context, Hono } from 'hono';
import { mountOperations, problemResponse, type ResolveStub } from '@substrat-run/vertical-host';
import { todoOperations } from '../spec/model.js';

export type { ResolveStub };

export function mountApi(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  app: Hono<any, any, any>,
  resolveStub: ResolveStub,
): { operation: string; method: string; path: string }[] {
  // The mount decides the STATUS for everything the kernel itself names — a
  // refused permission, an input that failed to parse, `resolveStub` refusing an
  // anonymous call — and re-throws the rest untouched (#791). Since #113 that
  // includes every throw carrying a taxonomy code, and this vertical's own refusals
  // all carry one.
  //
  // What is left of the error map is nothing (#113 phase 4). The last two patterns
  // were PLATFORM vocabulary read through its prose — an operation nobody declared,
  // a feature this tenant does not hold — and both are typed `not_found` at their
  // throw site now, including the deliberate 404 for the second, where a 403 would
  // confirm the feature exists. `problemResponse` renders the body.
  app.onError((err, c: Context) => problemResponse(c, err));

  return mountOperations(app, todoOperations, resolveStub);
}
