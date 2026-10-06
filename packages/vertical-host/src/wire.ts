/**
 * The one door between an operation and anyone outside this deployment (#2073).
 *
 * Every external transport — the HTTP mount (paged and whole), the MCP endpoint, a peer
 * vertical's call (`/internal/vertical-invoke`) and the connector write-back
 * (`/internal/connector-invoke`) — hands what the caller sent through `externalInput` before
 * invoking, and what the operation answered through `externalResult` before serialising. A
 * transport added later takes the same two calls; `wire.test.ts` enumerates the ones that exist.
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
import { withoutRowCursors } from '@substrat-run/contracts';

/** What an external caller sent, without the one parameter only an internal walk may set. */
export function externalInput<I>(input: I): I {
  if (input === null || typeof input !== 'object' || Array.isArray(input) || !('rowCursors' in input)) {
    return input;
  }
  const { rowCursors: _internal, ...rest } = input as Record<string, unknown>;
  return rest as I;
}

/** What an operation answered, as it may leave: no `rowCursors` on any page, however nested. */
export function externalResult<R>(result: R): R {
  return withoutRowCursors(result);
}
