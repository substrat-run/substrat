---
"@substrat-run/contracts": patch
"@substrat-run/kernel": patch
"@substrat-run/vertical-host": patch
"@substrat-run/adapter-sqlite": patch
"@substrat-run/adapter-cloudflare": patch
"@substrat-run/contract-tests": patch
"@substrat-run/control-plane-api": patch
"@substrat-run/router": patch
"@substrat-run/vertical-egress": patch
"@substrat-run/dashboard": patch
"@substrat-run/dashboard-web": patch
---

A request started by another one through a peer call can now be related to it. The invocation line has an optional `parentInvocationId`, written only when there is one, so every other line is unchanged. A peer call carries the calling request's id on the `x-substrat-parent-request-id` header, from `peerClient` through the egress worker and the router to the target's `/internal/vertical-invoke`. The target now runs the operation under its own request id, so its events are stamped, and writes one invocation line per peer call, naming the caller as the parent. The tenant on that line is the one in the platform-verified body. The parent id is the caller's own claim: each hop passes it on only as a single ULID and drops anything else, and it is used only to relate two requests. The dashboard's request panel lists the caller as "Caused by … peer call", and opening it reads that id under the team's own tenant and app.

A purge schedule's run now runs every purge in its pass under the run's own invocation id, on both adapters, so the purges' events and deliveries join the run's line. Before, each purge minted an id that no line named.

The dashboard's create, retry and resume failure toasts now name the request id when the answer carried one.
