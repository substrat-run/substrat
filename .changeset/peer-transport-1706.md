---
'@substrat-run/contracts': minor
'@substrat-run/adapter-cloudflare': minor
'@substrat-run/adapter-sqlite': minor
'@substrat-run/control-plane-api': minor
'@substrat-run/vertical-host': minor
'@substrat-run/cli': minor
'@substrat-run/router': patch
'@substrat-run/vertical-egress': patch
'@substrat-run/control-plane': patch
---

A deployed vertical can now call another vertical of the same tenant. The platform says which app is calling, so the caller holds no credential (#1706, part 2: the hosted transport). Part 1 built the door; this is the path to it.

**What a vertical author writes.** The caller declares who it calls, in package.json:

```json
{ "substrat": { "calls": ["acme/crm"] } }
```

and calls it from its harness:

```ts
const { items } = await peerClient('acme/crm').invoke('customer/list', { limit: 50 });
```

There is no address, no token and no outbound-allowlist entry. What the caller may then DO is the target's own `peers` declaration, which its permission diff reviews.

**How the platform knows who is calling.** The call goes to one reserved address, `peer.substrat.internal`, which is in no DNS zone:

- the **egress worker** — which every dispatched `fetch` passes through — recognises that address before its outbound policy and hands the call to the router, with the caller taken from the dispatch parameters the router set when it dispatched the caller. Nothing in the request contributes to it, and the body is strict, so it cannot carry one;
- the **router**'s `PeerCalls` entrypoint (reachable only through a service binding, never over its public `fetch`) resolves the target in the caller's own tenant and dispatches the target's `/internal/vertical-invoke`;
- a call made where egress cannot see it — from inside a Durable Object, which outbound workers do not intercept — **fails to resolve** instead of leaving the isolate. That is why the address is unroutable rather than real.

**Module code reaches a peer asynchronously.** An operation, a consumer or a schedule runs inside the scope's Durable Object, where module code has no network by rule. It enqueues a `peer-invoke` platform intent instead (`ctx.requestPlatform`), and the control plane's drain delivers it with the caller taken from the scope it found the row in. At-least-once, with the intent id as the idempotency key.

**The gates, on both legs:**
- the caller's declared `substrat.calls` (a version pushed before the declaration carries `null` and is unenforced, exactly as a pre-#303 `outbound` is);
- the caller is a live, primary instance of the vertical it claims — never a preview, and the refusal names the local broker as the way to test the edge;
- the target resolves to exactly one primary, active instance **in the caller's tenant**, never guessed when a tenant runs two;
- a synchronous chain is bounded by `PEER_CALL_DEPTH_MAX`, its own constant, deliberately not shared with #1705's event hop cap.

**Contract additions.** `@substrat-run/contracts` adds `peer-transport.ts` (`PEER_CALL_HOST`, `PEER_CALL_URL`, `isPeerCallHost`, `PEER_CALL_DEPTH_MAX`, `peerCallRequest`, `peerCaller`, `callsDeclares` and the refusal messages) and the `peer-invoke` intent kind with its payload. The deploy manifest, `RouteTarget` and the version record each gain `calls` beside `outbound`, lifted from the stored manifest by `callsOfManifestJson`. `@substrat-run/vertical-host` exports `peerClient`; `@substrat-run/control-plane-api` adds `VerticalClient.verticalInvoke` and `peerInvokeHandler`; the Cloudflare adapter adds `createPeerCallResolver` and the directory's `peerCallTarget` read.

**Operators:** the egress worker needs its new `PEER_CALLS` binding to the router's `PeerCalls` entrypoint, and the router now deploys from `src/index.ts` (which exports both the fetch handler and that entrypoint). Without the binding, peer calls are refused — never passed through.

Not in this release: the console and dashboard controls for the kill switch, a binding for a tenant that runs two instances of one vertical, and the model DSL for `peers`.
