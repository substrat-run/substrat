/**
 * Request-body parsing for the routes vertical-auth mounts (`mountInviteRoutes`,
 * `mountOwnerClaim`) — one definition, so they answer a bad body the same way.
 */

import type { Context } from 'hono';
import { HTTPException } from 'hono/http-exception';
import type { z } from '@substrat-run/contracts';

/**
 * The request body, parsed against the route's schema — or a 400 that names what was
 * wrong. Both failure shapes are turned into an `HTTPException` here so the promise
 * each mount here makes holds: a body that is not JSON would otherwise surface as the
 * `SyntaxError` `c.req.json()` throws (a 500 under any `onError` that does not know it),
 * and a body that does not fit the schema as a `ZodError` the vertical would have to map
 * itself. The issue list is written into the message rather than a structured body
 * because the vertical's own envelope decides the body shape, and a message is the one
 * thing every envelope carries through.
 */
export async function bodyOf<T>(c: Context, schema: z.ZodType<T>): Promise<T> {
  let raw: unknown;
  try {
    raw = await c.req.json();
  } catch {
    throw new HTTPException(400, { message: 'the request body must be JSON' });
  }
  const parsed = schema.safeParse(raw);
  if (!parsed.success) {
    const issues = parsed.error.issues.map((i) => `${i.path.join('.') || 'body'}: ${i.message}`).join('; ');
    throw new HTTPException(400, { message: `invalid request body — ${issues}` });
  }
  return parsed.data;
}
