/**
 * The HTTP surface — one line of mounting, and an error map that is one line too.
 *
 * There is no route table here. Method, path and which input fields the path carries
 * are declared on the operations themselves and compile-checked there, so
 * `mountOperations` derives the table at mount time.
 */
import type { Context, Hono } from 'hono';
import { mountOperations, problemResponse, type ResolveStub } from '@substrat-run/vertical-host';
import { ticket0Operations } from '../spec/model.js';

export type { ResolveStub };

export function mountApi(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  app: Hono<any, any, any>,
  resolveStub: ResolveStub,
): { operation: string; method: string; path: string }[] {
  // The mount decides the status for everything the kernel itself names — a refused
  // permission, an input that failed to parse, an anonymous call — and re-throws the
  // rest untouched. Every refusal this vertical raises carries a taxonomy code, so
  // what is left of the error map is nothing.
  app.onError((err, c: Context) => problemResponse(c, err));

  return mountOperations(app, ticket0Operations, resolveStub);
}
