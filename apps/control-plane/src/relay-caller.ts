import { RELAY_CALLER_HEADER, relayCaller, scopeId, type RelayCaller, type ScopeId, type TenantId } from '@substrat-run/contracts';

/**
 * Who called the relay — the half of the relay's authentication its platform check does not
 * supply.
 *
 * That check establishes that a platform script is calling, not which vertical, so the
 * `(tenantId, scopeId)` in the body is the caller's own claim. The egress worker knows
 * better: the router set the dispatched caller as the script's dispatch parameters, and the
 * egress worker forwards relay calls into `RelayGateway`, a named entrypoint that only a
 * service binding can reach, with that caller attached.
 *
 * **Held by the request object, never by a header the routes read.** The gateway parses the
 * caller once and records it against the exact `Request` it hands the worker. A request off
 * the public origin can carry the same header and it means nothing there: no route reads the
 * header, and the public `fetch` never puts anything in this map.
 */
const callers = new WeakMap<Request, RelayCaller>();

/**
 * The gateway's half: parse the caller the egress worker attached, and return the request the
 * worker should serve with that caller held against it. A missing or malformed caller is a
 * 400, not an unproven call: only the egress worker reaches this entrypoint, and if it sent
 * something unreadable, guessing would be the wrong repair.
 */
export function relayGatewayRequest(request: Request): Request | Response {
  const raw = request.headers.get(RELAY_CALLER_HEADER);
  let parsed: ReturnType<typeof relayCaller.safeParse> | undefined;
  try {
    parsed = raw === null ? undefined : relayCaller.safeParse(JSON.parse(raw));
  } catch {
    parsed = undefined;
  }
  if (!parsed?.success) {
    return Response.json({ error: 'relay gateway: the caller is missing or unreadable' }, { status: 400 });
  }
  const served = new Request(request);
  served.headers.delete(RELAY_CALLER_HEADER);
  callers.set(served, parsed.data);
  return served;
}

/** The caller the gateway proved for this request, or `undefined` for one off the public origin. */
export function relayCallerOf(request: Request): RelayCaller | undefined {
  return callers.get(request);
}

export interface RelayCallerEnv {
  /**
   * `'true'` refuses a relay call that arrives without a proven caller. Unset lets it through
   * as it always was, for the calls that cannot carry one yet: those made from inside a
   * Durable Object (Cloudflare's outbound workers do not see them), those made while serving
   * one of this worker's own dispatches (`dispatch.get(ref)` passes no outbound policy, so
   * the egress worker has no caller to give), and those from an environment whose egress
   * worker predates the gateway. Turned on once none of them remains.
   */
  RELAY_REQUIRE_CALLER?: string;
}

/** What a relay route decides about its caller before it acts on the scope the body names. */
export type RelayCallerVerdict = { ok: true; proven: boolean } | { ok: false; error: string };

/** The directory's word on a scope, as far as the relay needs it. */
export type RelayScopeLookup = (
  tenantId: TenantId,
  scopeId: ScopeId,
) => Promise<{ vertical: string | null; status: string } | undefined>;

/**
 * Hold the scope a relay body names to the caller that sent it.
 *
 * A proven caller may act for its own (tenant, scope), and for a sibling its own install
 * serves (#2803): a scope of the same tenant, active in the directory, running the same
 * vertical. A multi-scope vertical serves one hostname and selects the other scopes with
 * `x-scope`/`x-site`, so the router's dispatched scope is not always the one a call is made
 * for — and the vertical can already reach every such sibling, so this widens nothing. The
 * rule is the one `archiveScopeHandler` applies, and the directory is read only when the
 * scopes differ. Another tenant's scope, or another vertical's, is still refused.
 *
 * An unproven caller passes unless `RELAY_REQUIRE_CALLER` is on, and the route is told which
 * it was, so a capability that must never be reachable on the secret alone can insist on
 * `proven`.
 */
export async function checkRelayCaller(
  request: Request,
  env: RelayCallerEnv,
  named: { tenantId: string; scopeId: string },
  lookup: RelayScopeLookup,
): Promise<RelayCallerVerdict> {
  const caller = relayCallerOf(request);
  if (!caller) {
    return env.RELAY_REQUIRE_CALLER === 'true'
      ? { ok: false, error: 'relay refused: this call carries no proven caller (it must come from a dispatched vertical)' }
      : { ok: true, proven: false };
  }
  const refused: RelayCallerVerdict = { ok: false, error: `relay refused: '${caller.vertical}' may only act for its own scope` };
  if (caller.tenantId !== named.tenantId) return refused;
  if (caller.scopeId === named.scopeId) return { ok: true, proven: true };
  const siblingId = scopeId.safeParse(named.scopeId);
  if (!siblingId.success) return refused;
  const sibling = await lookup(caller.tenantId, siblingId.data);
  if (!sibling || sibling.status !== 'active' || sibling.vertical !== caller.vertical) return refused;
  return { ok: true, proven: true };
}

/**
 * The (tenant, scope) a relay body names, read loosely: each relay parses its own body
 * strictly afterwards, and a body naming nothing still has to be compared with a proven
 * caller — as two empty strings, which match no scope.
 */
export function scopeNamedBy(body: unknown): { tenantId: string; scopeId: string } {
  const o = body !== null && typeof body === 'object' ? (body as Record<string, unknown>) : {};
  const text = (v: unknown) => (typeof v === 'string' ? v : '');
  return { tenantId: text(o.tenantId), scopeId: text(o.scopeId) };
}
