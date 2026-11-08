/**
 * The HTTP surface — one line of mounting.
 *
 * There is no route table here. Method, path and which input fields the path carries are
 * declared on the operations themselves and compile-checked there, so `mountOperations`
 * derives the table at mount time.
 *
 * `tock/profile-run` declares no `http`, so this mounts nothing for it. That is the point:
 * it takes already-parsed records, and a public route would let a browser supply them.
 */
import type { Context, Hono } from 'hono';
import { mountOperations, problemResponse, type ResolveStub } from '@substrat-run/vertical-host';
import { tockOperations } from '../spec/model.js';
import { API_DOCUMENT } from './api.js';

export type { ResolveStub };

export function mountApi(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  app: Hono<any, any, any>,
  resolveStub: ResolveStub,
): { operation: string; method: string; path: string }[] {
  app.onError((err, c: Context) => problemResponse(c, err));
  // `/api/docs` renders the document this app already serves at `/openapi.json`, tags and prose
  // included, rather than the one the mount would derive from the same operations.
  return mountOperations(app, tockOperations, resolveStub, { docs: { document: API_DOCUMENT } });
}
