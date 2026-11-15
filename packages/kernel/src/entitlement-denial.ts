/**
 * The §4.3 entitlement gate's refusal, in two halves that go to two different readers (#3105).
 *
 * ## What the caller reads
 *
 * {@link entitlementDenial} is the `detail` of the refusal, and the refusal reaches whoever made
 * the request: a person using one vertical, with no role in managing the tenant. So it names the
 * operation they called and the one key it needs, and nothing the tenant holds. It used to list
 * every key the tenant held (#691), which told any signed-in member of one vertical which other
 * products the tenant runs. A refusal visible to a caller carries nothing about other verticals.
 *
 * Its code is `not_found` at every throw site (#113). Not `forbidden`: the taxonomy's
 * `not_found` row already covers "exists, and must read as absent", and every vertical had
 * independently arrived at a 404 here — *"a 403 would confirm the feature exists"*
 * ([`todo/routes.ts`](../../../demos/todo/src/routes.ts)).
 *
 * ## What the operator reads
 *
 * #691's diagnosis still stands: required-vs-held is how a key that is *nearly* right
 * (workspace-prefixed, misspelled, expired) is found, and the 2026-08-15 lockout spent half a
 * day on "buy the SKU" because only the required key was visible. So the held keys are still
 * written, to the server-side log instead of the response: {@link entitlementDenialLine}, keyed
 * by the request id the response carries in `x-substrat-request-id`, so a person who quotes the
 * id lets an operator find the full line. `held` is every key projected for the tenant, expired
 * ones included and marked: a lapsed grant denies exactly like an absent one, and "you had it, it
 * ran out" is a different fix from "you never had it".
 *
 * {@link refuseEntitlement} writes the line and builds the refusal, so the three throw sites (the
 * Cloudflare coordinator against the shared CP, a scope DO against its projection, the SQLite
 * adapter against its directory) cannot report one without the other.
 */
import { substratError, type SubstratError } from '@substrat-run/contracts';

// Runtime global, declared rather than imported, as `module-log.ts` declares it: this package
// compiles with no DOM and no workers types.
declare const console: { warn(message: string): void };

/** One key the tenant is granted, as the denial's server-side line reports it. */
export interface HeldEntitlement {
  key: string;
  expired: boolean;
}

/** Everything one denial knows. Only `operation` and `requiredKey` reach the caller. */
export interface EntitlementDenialFacts {
  operation: string;
  requiredKey: string;
  /** Every key projected for the tenant, expired ones included. Server-side only. */
  held: readonly HeldEntitlement[];
  tenantId: string;
  scopeId: string;
  /** The call's `invocationId` — its `x-substrat-request-id`. `null` for an in-process call. */
  requestId?: string | null;
}

/** The operator's line: the full required-vs-held diagnosis, keyed by request id. */
export interface EntitlementDenialLine {
  substrat: 'entitlement-denied';
  level: 'warn';
  tenantId: string;
  scopeId: string;
  requestId: string | null;
  operation: string;
  required: string;
  /** `key` or `key (expired)`, one per key the tenant is granted. */
  held: string[];
  message: string;
}

/** Where a host sends the line. The default writes one JSON line to the runtime's console. */
export type EntitlementDenialSink = (line: EntitlementDenialLine) => void;

export const consoleEntitlementDenialSink: EntitlementDenialSink = (line) =>
  console.warn(JSON.stringify(line));

/** The caller-visible `detail`: the operation and the key it needs, never what the tenant holds. */
export function entitlementDenial(operation: string, requiredKey: string): string {
  return `operation not entitled: ${operation} — tenant does not hold '${requiredKey}'`;
}

/** The server-side line for one denial. */
export function entitlementDenialLine(facts: EntitlementDenialFacts): EntitlementDenialLine {
  return {
    substrat: 'entitlement-denied',
    level: 'warn',
    tenantId: facts.tenantId,
    scopeId: facts.scopeId,
    requestId: facts.requestId ?? null,
    operation: facts.operation,
    required: facts.requiredKey,
    held: facts.held.map((h) => (h.expired ? `${h.key} (expired)` : h.key)),
    message: 'operation refused: the tenant does not hold the entitlement it requires',
  };
}

/** Write the denial's server-side line, then return the refusal the caller receives. */
export function refuseEntitlement(
  facts: EntitlementDenialFacts,
  sink: EntitlementDenialSink = consoleEntitlementDenialSink,
): SubstratError {
  sink(entitlementDenialLine(facts));
  return substratError('not_found', entitlementDenial(facts.operation, facts.requiredKey));
}
