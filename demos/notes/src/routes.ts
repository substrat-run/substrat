/**
 * The HTTP surface: derived from the operations' own `http` declarations at mount time.
 */
import type { Context, Hono } from 'hono';
import { mountOperations, problemResponse, type ResolveStub } from '@substrat-run/vertical-host';
import { notesOperations } from '../spec/model.js';
import { API_DOCUMENT } from './api.js';

export function mountApi(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  app: Hono<any, any, any>,
  resolveStub: ResolveStub,
): { operation: string; method: string; path: string }[] {
  app.onError((err, c: Context) => problemResponse(c, err));
  // `/api/docs` renders the document `openapi.json` is checked in from.
  return mountOperations(app, notesOperations, resolveStub, { docs: { document: API_DOCUMENT } });
}
