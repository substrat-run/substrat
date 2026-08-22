import type { ContentfulStatusCode } from 'hono/utils/http-status';
import { errorCodeOf } from '@substrat-run/contracts';
import { SecretBoxUnconfiguredError } from '@substrat-run/kernel';
import { ControlPlaneError } from './client.js';
import { ConnectionRelayError } from './connection-relay.js';

/**
 * Map an adapter throw onto an HTTP status.
 *
 * `HostAdmin` throws plain `Error`s — deliberately, so their messages survive
 * the Cloudflare RPC hop intact (a ZodError would not). That leaves this layer
 * matching on message text, which is the weakest seam in this package and worth
 * naming rather than hiding:
 *
 * - It is less brittle than it looks. Every pattern below is a message the
 *   CONTRACT SUITE asserts on (`/unknown tenant/`, `/illegal scope transition/`,
 *   `/already taken/`, `/not active/`), against both adapters. Changing one
 *   turns a contract test red, not just this mapping.
 * - It is still text. The durable fix is typed errors on `HostAdmin` — a tagged
 *   union the adapters throw and this reads. That is a kernel change, and it is
 *   not worth blocking the transport on.
 *
 * Anything unmatched is a 500 with a GENERIC body: an unrecognised throw is, by
 * definition, one whose message we have not reviewed for what it discloses, and
 * this surface has cross-tenant reach.
 */
/**
 * ORDER IS SIGNIFICANT — first match wins, so every specific pattern must precede
 * the general one it would otherwise be swallowed by. `cannot provision scope
 * under unknown tenant` contains `unknown tenant:`, and listing the general one
 * first turned a precondition conflict into a 404 claiming POST /scopes does not
 * exist. That is the message-matching fragility this file admits to above, caught
 * by the test below rather than by reading.
 */
const STATUS_PATTERNS: readonly [RegExp, ContentfulStatusCode][] = [
  // Well-formed, but conflicts with current state or references something absent.
  // The addressed collection exists; the request cannot be applied to it.
  [/cannot provision scope under unknown tenant/, 409],
  [/already taken/, 409],
  [/illegal scope transition/, 409],
  [/non-active tenant/, 409],
  [/not active \(status:/, 409],
  // Registry (#31): well-formed, but conflicts with a version's admission state or
  // ownership, or needs an unacknowledged change acknowledged (the two checkpoints).
  [/is already registered/, 409],
  // claim-on-first-push (builder-plane.md): a slug's owner is fixed at first push.
  // A staff re-registration under a different owner is a conflict; a builder is
  // refused with 403 in the transport before it reaches this throw.
  [/is owned by /, 409],
  [/was rejected — publish a new one/, 409],
  [/is already admitted/, 409],
  // The publish seam's refusal (marketplace-publish.md §5): prod points at a version
  // carrying only the AUTO admission note, so no human has vouched for code that listing
  // would expose to every tenant. It names its own way out — a staff admit of that
  // version — and without this entry it fell through to the generic 500 below, which is
  // how the console's List button came to answer `internal error` and the operator had
  // no way to learn that an admit was what it wanted. Pinned by the contract suite
  // (`/auto-admitted.*staff admit/`) against both adapters, like every pattern here.
  [/is auto-admitted \(private self-serve\)/, 409],
  [/belongs to '/, 409],
  [/not admitted/, 409],
  [/acknowledge it explicitly to promote/, 409],
  // deleteVertical's bound-scope refusal — the message names the count and the way
  // out (delete or rebind the scopes), so it must reach the caller, not collapse
  // into the generic 500 below.
  [/still backs \d+ scope\(s\)/, 409],
  // The §4 sandbox contract: a declared binding reaches platform infrastructure.
  // Forbidden, not a conflict — the upload is well-formed and still refused.
  [/deploy refused:/, 403],
  // The ADDRESSED resource does not exist — including the K-3 fail-closed case
  // where it exists under a DIFFERENT tenant and must read as absent.
  [/unknown tenant:/, 404],
  [/unknown scope for tenant/, 404],
  [/unknown scope /, 404],
  // A read-only introspection read (§5.4) for a table the scope's schema does not have.
  [/unknown table /, 404],
  // The SQL console's gate (#219) refused the statement — a malformed request, not a
  // server fault. The prefix is pinned by the contract suite against both adapters.
  [/read-only console/, 400],
  [/unknown vertical /, 404],
  [/unknown version /, 404],
  [/scope has no tenant record/, 404],
];

export interface ApiError {
  status: ContentfulStatusCode;
  body: { error: string };
}

export function mapError(err: unknown): ApiError {
  // A ControlPlaneError is a DELIBERATE downstream answer, not an unreviewed throw —
  // the VerticalClient wraps the vertical's own JSON status/message in it. Passing it
  // through verbatim is what lets an honest refusal (e.g. auth-server's 501 for an
  // unimplemented verb) reach the dashboard as itself, instead of collapsing into the
  // generic 500 below (the shape of the 2026-07-25 incident, on this side of the seam).
  // Several routes hand-catch it already; this makes the boundary consistent for the rest.
  if (err instanceof ControlPlaneError) {
    return { status: err.status as ContentfulStatusCode, body: { error: err.message } };
  }
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
    const message = err instanceof Error ? err.message : String(err);
    return { status: 503, body: { error: message } };
  }
  // The relay's own refusals already carry a reviewed status and message. The connection
  // route answers the 4xx ones itself (a 422 additionally carries the provider's probe);
  // a 503 reaches here because the route rethrows it, so that the platform's own
  // inability lands an ops-failure row (#559) instead of vanishing into the operator's
  // screen alone.
  if (err instanceof ConnectionRelayError) {
    return { status: err.status, body: { error: err.message } };
  }
  const message = err instanceof Error ? err.message : String(err);
  for (const [pattern, status] of STATUS_PATTERNS) {
    if (pattern.test(message)) return { status, body: { error: message } };
  }
  return { status: 500, body: { error: 'internal error' } };
}
