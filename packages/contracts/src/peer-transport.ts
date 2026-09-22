import { z } from 'zod';
import { scopeId, tenantId, verticalSlug } from './ids.js';

/**
 * The hosted transport for a peer call (#1706, part 2) — how a deployed vertical reaches
 * another vertical of the same tenant, and how the platform says WHICH vertical is calling.
 *
 * The shape, because every piece below only makes sense against it:
 *
 * 1. A vertical's harness fetches `PEER_CALL_URL`, naming the TARGET and the operation in the
 *    body. It names no caller: it has no way to.
 * 2. The **egress worker** — which every dispatched `fetch` passes through — recognises that
 *    one reserved address and hands the call to the router, together with the dispatch
 *    parameters the ROUTER set when it dispatched the caller (`OUTBOUND_POLICY`: the calling
 *    vertical, its instance, its declared `calls`, and the depth). Nothing in the request is
 *    trusted for identity.
 * 3. The **router** resolves the target in the caller's own tenant and dispatches the target's
 *    `/internal/vertical-invoke`, where the peer door admits it (part 1).
 *
 * **Why an address that does not resolve.** `*.substrat.internal` is in no DNS zone. A
 * `fetch` egress cannot police — one made from inside a Durable Object, which Cloudflare's
 * outbound workers do not intercept — therefore FAILS rather than leaving for the internet.
 * The alternative, a real `*.substrat.run` name, would have left that call resolvable and
 * routed it to the public router, where it would arrive with no identity. Failing closed at
 * the socket is the better half of that choice, and it is pinned by a test.
 */

/** The one reserved host a peer call is addressed to. In no DNS zone, deliberately. */
export const PEER_CALL_HOST = 'peer.substrat.internal';

/** The full address a peer call is made to. The caller never builds this by hand. */
export const PEER_CALL_URL = `https://${PEER_CALL_HOST}/invoke`;

/** Is this destination the peer transport? An exact host match, never a suffix test. */
export const isPeerCallHost = (hostname: string): boolean =>
  hostname.toLowerCase() === PEER_CALL_HOST;

/**
 * How deep a chain of SYNCHRONOUS peer calls may go: A calls B, which calls C…
 *
 * Its own constant, deliberately NOT shared with the cross-vertical event hop cap (#1705).
 * The two bound different things — a call chain holds a request open at every hop and costs
 * latency and an isolate each, while an event re-export chain is asynchronous and costs a
 * delivery — so one number would couple two features that must move independently.
 */
export const PEER_CALL_DEPTH_MAX = 4;

/**
 * What a caller puts in the body: the target and the operation, and nothing about itself.
 *
 * STRICT, and that is the contract: the caller is supplied by the platform from the dispatch
 * it is running under, so a body that tried to name one would be refused rather than believed.
 */
export const peerCallRequest = z
  .object({
    vertical: verticalSlug,
    operation: z.string().min(1),
    input: z.unknown().optional(),
    idempotencyKey: z.string().min(1).optional(),
  })
  .strict();
export type PeerCallRequest = z.infer<typeof peerCallRequest>;

/** What the transport answers with. An operation may legitimately return nothing. */
export const peerCallResponse = z.object({ result: z.unknown() });
export type PeerCallResponse = z.infer<typeof peerCallResponse>;

/**
 * WHO is calling, as the platform knows it — the dispatch parameters the router sets, read by
 * the egress worker and handed to the router's peer entrypoint. Never assembled from a request.
 *
 * `depth` is the chain position of the call now running: 0 for a call a person's request set
 * off, 1 for a peer call made while serving a peer call, and so on.
 */
export const peerCaller = z.object({
  vertical: verticalSlug,
  tenantId,
  scopeId,
  /** The calling version's declared `substrat.calls`. `null` = a version that predates it. */
  calls: z.array(verticalSlug).nullable(),
  depth: z.number().int().min(0),
});
export type PeerCaller = z.infer<typeof peerCaller>;

/** May this caller call `target`, by its own declaration? A pre-`calls` version is unenforced. */
export const callsDeclares = (calls: readonly string[] | null, target: string): boolean =>
  calls === null || calls.includes(target);

/** The refusal an undeclared target earns, worded for the builder who has to fix it. */
export const undeclaredCallMessage = (caller: string, target: string): string =>
  `'${caller}' does not declare '${target}' in its outgoing calls. Add it to package.json ` +
  `substrat.calls (e.g. ["${target}"]) and push a new version — the declaration is reviewed ` +
  `at the admit checkpoint, like substrat.outbound (#1706).`;

/** The refusal a preview earns. It names the way to exercise the edge instead. */
export const previewCallerMessage = (vertical: string): string =>
  `peer calls are not available from a preview (the caller must be a primary, active scope), ` +
  `so '${vertical}' cannot call another vertical from here. Test this edge locally with the ` +
  `vertical broker (createLocalVerticalBroker from '@substrat-run/adapter-sqlite/vertical-broker'), ` +
  `or install both verticals in a tenant.`;

/** The refusal a too-deep chain earns. */
export const callDepthMessage = (depth: number): string =>
  `peer call refused: this call is already ${depth} deep, and a chain may be at most ` +
  `${PEER_CALL_DEPTH_MAX} (#1706). A chain that long is usually two verticals calling each ` +
  `other in a loop; an event is the shape for work that does not need an answer.`;
