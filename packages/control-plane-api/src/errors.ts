import type { ContentfulStatusCode } from 'hono/utils/http-status';
import {
  errorCodeOf,
  PROBLEM_CATALOG,
  problemForStatus,
  substratError,
  toProblem,
  type ErrorCode,
  type Problem,
} from '@substrat-run/contracts';
import { SecretBoxUnconfiguredError } from '@substrat-run/kernel';
import { ControlPlaneError } from '@substrat-run/control-plane-client';
import { ConnectionRelayError } from './connection-relay.js';

/**
 * Map a `HostAdmin` throw onto a problem document — #113.
 *
 * **The code decides, and nothing else does.** A throw that declared what it is
 * (`substratError`, `PermissionDenied`, anything carrying a `Substrat.<code>` name) is
 * rendered from its own declaration by `toProblem`, extensions and all. There is no
 * message table behind it any more: every `HostAdmin` refusal that used to reach one is
 * typed at its throw site, on both adapters, and the contract suite asserts the code
 * rather than the sentence. The last fourteen rows went together, so a reworded refusal
 * can no longer slip past the table into the generic 500, or be caught by the wrong row.
 *
 * Where the throw is raised inside a Durable Object, its code does not survive being
 * THROWN across the hop: workerd folds `name` into the message and drops every own
 * property. Those refusals travel as a value instead — the DO answers a `DoReply`
 * (`adapter-cloudflare/src/do-reply.ts`) or a refusal record, and the coordinator throws
 * it, typed, on this side. So a new DO-side refusal needs that envelope as well as its
 * code, or it arrives here untyped.
 *
 * Anything untyped is a 500 with a GENERIC body: an unrecognised throw is, by
 * definition, one whose message we have not reviewed for what it discloses, and this
 * surface has cross-tenant reach. That is also what makes a new untyped refusal VISIBLE:
 * it answers `internal error` in its first test, rather than being quietly matched.
 */
export interface ApiError {
  status: ContentfulStatusCode;
  body: Problem;
}

/** A body built from a code this layer decided, rather than one the throw declared. */
const coded = (code: ErrorCode, message: string): ApiError => ({
  status: PROBLEM_CATALOG[code].status as ContentfulStatusCode,
  body: toProblem(substratError(code, message)),
});

/** A status raised somewhere else and relayed — `about:blank`, because it is not ours. */
const relayed = (status: number, message: string): ApiError => ({
  status: status as ContentfulStatusCode,
  body: problemForStatus(status, message),
});

export function mapError(err: unknown): ApiError {
  // A ControlPlaneError is a DELIBERATE downstream answer, not an unreviewed throw —
  // the VerticalClient wraps the vertical's own JSON status/message in it. Passing it
  // through verbatim is what lets an honest refusal (e.g. auth-server's 501 for an
  // unimplemented verb) reach the dashboard as itself, instead of collapsing into the
  // generic 500 below (the shape of the 2026-07-25 incident, on this side of the seam).
  // Several routes hand-catch it already; this makes the boundary consistent for the rest.
  //
  // `about:blank`: the status is the downstream's, and putting OUR taxonomy on someone
  // else's refusal would be a claim we have no standing to make.
  if (err instanceof ControlPlaneError) return relayed(err.status, err.message);
  // A deployment fact, not a fault in the request (#603, #828): this host was started
  // without a piece of platform wiring, so a whole capability cannot work — no seal key
  // (the connection store, the subject keys, the per-tenant D1 credential seal), or no
  // store client (`provisionTenantStore` / `provisionBlobStore` with nothing to mint on).
  // Whatever the caller sent, the same request succeeds unchanged once the host is wired.
  //
  // Without this branch such a throw reached the generic 500 below and read as a bug in
  // the caller's payload — the shape of #828, where the control plane answered
  // `internal error` to a provision for four hours while the throw it was hiding named
  // its own fix in full. The message is OURS in every case (kernel or adapter, written
  // to be read by an operator, carrying no tenant data and no secret), which is what
  // licenses passing it through where an unreviewed message must not be.
  //
  // Matched by CODE, not by class: `errorCodeOf` reads the live property, the
  // `Substrat.<code>` name a throw keeps across an RPC hop, and the legacy class names —
  // so an adapter's refusal survives the DO boundary as itself. `SecretBoxUnconfiguredError`
  // is one of those legacy names and is covered here; the explicit check stays because it
  // predates the code and its absence would be silent.
  if (err instanceof SecretBoxUnconfiguredError || errorCodeOf(err) === 'unavailable') {
    return coded('unavailable', err instanceof Error ? err.message : String(err));
  }
  // The relay's own refusals already carry a reviewed status and message. The connection
  // route answers the 4xx ones itself (a 422 additionally carries the provider's probe);
  // a 503 reaches here because the route rethrows it, so that the platform's own
  // inability lands an ops-failure row (#559) instead of vanishing into the operator's
  // screen alone.
  if (err instanceof ConnectionRelayError) return relayed(err.status, err.message);

  // THE CODE (#113). A throw that declared what it is renders from its own declaration —
  // extensions included, so a `conflict` arrives carrying the `reason` the engine narrowed
  // it with, and a parse failure its field list.
  const declared = errorCodeOf(err);
  if (declared !== undefined && err instanceof Error) {
    return { status: PROBLEM_CATALOG[declared].status as ContentfulStatusCode, body: toProblem(err) };
  }

  // The generic 500. `toProblem` refuses to disclose the message — that is the rule, and
  // this surface has cross-tenant reach — so the body carries no `detail`. The deprecated
  // `error` duplicate is set by hand to the same constant this branch has always
  // answered with, because it is OURS rather than the throw's, and every SPA in the repo
  // still reads `{ error }`. It goes when the duplicate does.
  return { status: 500, body: { ...toProblem(err), error: 'internal error' } };
}
