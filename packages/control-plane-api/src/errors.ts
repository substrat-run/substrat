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
import { ControlPlaneError } from './client.js';
import { ConnectionRelayError } from './connection-relay.js';

/**
 * Map a `HostAdmin` throw onto a problem document — #113 phase 4.
 *
 * **The code is read first, and the table below is what is left.** A throw that
 * declared what it is (`substratError`, `PermissionDenied`, anything carrying a
 * `Substrat.<code>` name across the RPC hop) is rendered from its own declaration by
 * `toProblem`, extensions and all. Only a throw that declared nothing reaches the
 * patterns, and each pattern that survives is one more `HostAdmin` throw site nobody
 * has typed yet — a to-do list that shortens, rather than a mapping layer that grows.
 *
 * The table names a CODE now, not a status. The status follows from the catalog, so the
 * two can no longer disagree — and the entry says what the failure IS, which is the
 * thing a reviewer can check against the throw site. `409` was never checkable.
 *
 * What has not changed, and should not:
 *
 * - The patterns are less brittle than they look. Every one is a message the CONTRACT
 *   SUITE asserts on (`/unknown tenant/`, `/illegal scope transition/`, `/already
 *   taken/`, `/not active/`), against both adapters. Changing one turns a contract test
 *   red, not just this mapping. Phase 5 migrates those assertions onto codes and this
 *   table goes with them.
 * - Anything unmatched is a 500 with a GENERIC body: an unrecognised throw is, by
 *   definition, one whose message we have not reviewed for what it discloses, and this
 *   surface has cross-tenant reach.
 *
 * **ORDER IS SIGNIFICANT** — first match wins, so every specific pattern must precede
 * the general one it would otherwise be swallowed by. `cannot provision scope under
 * unknown tenant` contains `unknown tenant:`, and listing the general one first turned a
 * precondition conflict into a 404 claiming POST /scopes does not exist. That is the
 * message-matching fragility this file admits to above, caught by the test below rather
 * than by reading.
 */
const CODE_PATTERNS: readonly [RegExp, ErrorCode][] = [
  // Well-formed, but conflicts with current state or references something absent.
  // The addressed collection exists; the request cannot be applied to it.
  [/cannot provision scope under unknown tenant/, 'conflict'],
  [/already taken/, 'conflict'],
  [/illegal scope transition/, 'conflict'],
  [/non-active tenant/, 'conflict'],
  [/not active \(status:/, 'conflict'],
  // Registry (#31): well-formed, but conflicts with a version's admission state or
  // ownership, or needs an unacknowledged change acknowledged (the two checkpoints).
  [/is already registered/, 'conflict'],
  // claim-on-first-push (builder-plane.md): a slug's owner is fixed at first push.
  // A staff re-registration under a different owner is a conflict; a builder is
  // refused with 403 in the transport before it reaches this throw.
  [/is owned by /, 'conflict'],
  [/was rejected — publish a new one/, 'conflict'],
  [/is already admitted/, 'conflict'],
  // The publish seam's refusal (marketplace-publish.md §5): prod points at a version
  // carrying only the AUTO admission note, so no human has vouched for code that listing
  // would expose to every tenant. It names its own way out — a staff admit of that
  // version — and without this entry it fell through to the generic 500 below, which is
  // how the console's List button came to answer `internal error` and the operator had
  // no way to learn that an admit was what it wanted. Pinned by the contract suite
  // (`/auto-admitted.*staff admit/`) against both adapters, like every pattern here.
  [/is auto-admitted \(private self-serve\)/, 'conflict'],
  [/belongs to '/, 'conflict'],
  [/not admitted/, 'conflict'],
  [/acknowledge it explicitly to promote/, 'conflict'],
  // deleteVertical's bound-scope refusal — the message names the count and the way
  // out (delete or rebind the scopes), so it must reach the caller, not collapse
  // into the generic 500 below.
  [/still backs \d+ scope\(s\)/, 'conflict'],
  // The §4 sandbox contract: a declared binding reaches platform infrastructure.
  // Forbidden, not a conflict — the upload is well-formed and still refused.
  [/deploy refused:/, 'forbidden'],
  // The ADDRESSED resource does not exist — including the K-3 fail-closed case
  // where it exists under a DIFFERENT tenant and must read as absent.
  [/unknown tenant:/, 'not_found'],
  [/unknown scope for tenant/, 'not_found'],
  [/unknown scope /, 'not_found'],
  // A read-only introspection read (§5.4) for a table the scope's schema does not have.
  [/unknown table /, 'not_found'],
  // The SQL console's gate (#219) refused the statement — a malformed request, not a
  // server fault. The prefix is pinned by the contract suite against both adapters.
  [/read-only console/, 'validation_failed'],
  [/unknown vertical /, 'not_found'],
  [/unknown version /, 'not_found'],
  [/scope has no tenant record/, 'not_found'],
];

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

  // THE CODE, FIRST (#113 phase 4). A throw that declared what it is renders from its own
  // declaration — extensions included, so a `conflict` arrives carrying the `reason` the
  // engine narrowed it with, and a parse failure its field list. Everything below this
  // line is a throw site nobody has typed yet.
  const declared = errorCodeOf(err);
  if (declared !== undefined && err instanceof Error) {
    return { status: PROBLEM_CATALOG[declared].status as ContentfulStatusCode, body: toProblem(err) };
  }

  const message = err instanceof Error ? err.message : String(err);
  for (const [pattern, code] of CODE_PATTERNS) {
    if (pattern.test(message)) return coded(code, message);
  }
  // The generic 500. `toProblem` refuses to disclose the message — that is the rule, and
  // this surface has cross-tenant reach — so the body carries no `detail`. The deprecated
  // `error` duplicate is set by hand to the same constant this branch has always
  // answered with, because it is OURS rather than the throw's, and every SPA in the repo
  // still reads `{ error }`. It goes when the duplicate does.
  return { status: 500, body: { ...toProblem(err), error: 'internal error' } };
}
