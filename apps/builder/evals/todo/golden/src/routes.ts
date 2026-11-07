import type { Context, Hono } from 'hono';
import {
  externalInput,
  externalJson,
  mountOperations,
  problemResponse,
  type ResolveStub,
} from '@substrat-run/vertical-host';
import { operations } from '../spec/model.js';

export type { ResolveStub };

export function mountApi(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  app: Hono<any, any, any>,
  resolveStub: ResolveStub,
): { operation: string; method: string; path: string }[] {
  app.onError((err, c: Context) => problemResponse(c, err));

  // The route the web app's `invoke` calls: a thin wrapper over one operation.
  app.post('/api/invoke', async (c) => {
    const { op, input } = await c.req.json<{ op: string; input?: unknown }>();
    return externalJson(c, (await (await resolveStub(c)).invoke(op, externalInput(input))) ?? null);
  });

  return mountOperations(app, operations, resolveStub);
}
