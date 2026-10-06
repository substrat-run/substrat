/**
 * The one door between an operation and anyone outside this deployment (#2073).
 *
 * Every external transport — the HTTP mount (paged and whole), the MCP endpoint, a peer
 * vertical's call (`/internal/vertical-invoke`) and the connector write-back
 * (`/internal/connector-invoke`) — hands what the caller sent through `externalInput` before
 * invoking, and what the operation answered through `externalJson` (or `externalResult`, where
 * an object is needed) on the way out. A transport added later takes the same calls;
 * `wire.test.ts` enumerates the ones that exist. All are exported, so a vertical that mounts its
 * own generic route (meridian's `/api/invoke`, shop's page projection) goes through the same door.
 *
 * What they guard is `Page.rowCursors`: each row's own cursor, which `pageVisible` asks a read for
 * so that it can stop partway through a page. It is an internal channel, and these are the only
 * places it may travel:
 * - inside a scope: `ctx.page` → the module's `pageVisible` walk;
 * - over the in-process and Durable Object `invoke` between a host and a scope, for a walk the
 *   host runs itself (the `ctx.page` contract suite does).
 * Never to an external caller — a handler that filtered `entries` after its read would leave
 * them naming the rows it dropped — and never FROM one: only the walk may ask for them.
 *
 * A vertical's own `respond` envelope is handed the result before this, as it is everything
 * else: that envelope is the vertical's statement, and the field walk (#1331) holds that the
 * platform does not read a result it was not asked to.
 */
import type { Context } from 'hono';
import { serializeWithoutRowCursors, withoutRowCursors } from '@substrat-run/contracts';

/** What an external caller sent, without the one parameter only an internal walk may set. */
export function externalInput<I>(input: I): I {
  if (input === null || typeof input !== 'object' || Array.isArray(input) || !('rowCursors' in input)) {
    return input;
  }
  const { rowCursors: _internal, ...rest } = input as Record<string, unknown>;
  return rest as I;
}

/**
 * The JSON response for `value`: exactly `c.json(value)` — one serialisation, the same status and
 * `Content-Type` — except that no `rowCursors` survive it, at any depth (contracts'
 * `serializeWithoutRowCursors`: scrubbed at serialisation, so whatever shape reaches the wire is
 * the shape scrubbed).
 */
export function externalJson(c: Context, value: unknown, status?: Parameters<Context['json']>[1]): Response {
  return c.body((serializeWithoutRowCursors(value) ?? null) as string, status as never, {
    'Content-Type': 'application/json',
  });
}

/**
 * What an operation answered, as plain JSON data with no `rowCursors` in it — for a transport
 * that needs an object rather than a response (an MCP tool's structured content).
 */
export function externalResult<R>(result: R): R {
  return withoutRowCursors(result);
}
