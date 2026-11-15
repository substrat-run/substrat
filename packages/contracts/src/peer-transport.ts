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
 * A call may also carry a PERSON (#3161): `onBehalf` holds a delegated access token the caller
 * obtained at the issuer for a person signed in to it (the `peer` channel of `delegations.ts`).
 * That is still not the caller naming anyone. The TARGET verifies the token itself — its `aud`
 * is the target's own OIDC client, and its `act` is the app the target takes its people from —
 * and only a token that passes makes the call run as that person, its `scope` a ceiling over
 * what the person holds there. Nothing the caller writes in the body is believed for identity.
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
 * The person a peer call is made for (#3161): a delegated access token, opaque to the transport
 * and verified only by the target. Bounded because it rides in a body the egress worker and the
 * router both read; a JWT the issuer mints is far below the bound.
 */
export const peerOnBehalf = z.object({ token: z.string().min(1).max(8192) }).strict();
export type PeerOnBehalf = z.infer<typeof peerOnBehalf>;

/**
 * What a caller puts in the body: the target and the operation, and nothing about itself.
 *
 * STRICT, and that is the contract: the caller is supplied by the platform from the dispatch
 * it is running under, so a body that tried to name one would be refused rather than believed.
 * `onBehalf` names no principal either: it carries a token the target verifies (see above),
 * and a call without one runs as the calling vertical, as every peer call did before #3161.
 */
export const peerCallRequest = z
  .object({
    vertical: verticalSlug,
    operation: z.string().min(1),
    input: z.unknown().optional(),
    idempotencyKey: z.string().min(1).optional(),
    onBehalf: peerOnBehalf.optional(),
  })
  .strict();
export type PeerCallRequest = z.infer<typeof peerCallRequest>;

/**
 * "Which OIDC client are you?" — the one built-in peer operation (#3161). A caller exchanging a
 * person's token for the target needs the target's client id to name as `audience`, and nothing
 * else it holds says it.
 *
 * Answered by the target's PLATFORM layer, before any module operation is looked up, so no
 * module code ever sees or implements it, and a module operation given this name would be
 * unreachable through the transport. It is in the platform's `substrat.` namespace, which no
 * module operation uses (theirs are `<namespace>/<name>`). It answers any peer the platform
 * already lets call the target, with no allowlist entry of its own: a client id is not a
 * secret, since it is in every token the target's sign-in hands out.
 */
export const PEER_CLIENT_OPERATION = 'substrat.peer-client';

/** The answer to {@link PEER_CLIENT_OPERATION}. `null`: the target signs nobody in at an issuer. */
export const peerClientAnswer = z.object({ clientId: z.string().min(1).nullable() });
export type PeerClientAnswer = z.infer<typeof peerClientAnswer>;

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
