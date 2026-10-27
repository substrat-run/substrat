---
id: D-64
date: 2026-10-26
layer: plan
title: "A vertical may define its own connector, and it runs in the vertical's worker with a capability narrowed to one connection"
status: proposed
aliases: []
amends: ["D-18"]
tracking: ["#2614"]
---
# D-64 — A vertical may define its own connector, and it runs in the vertical's worker with a capability narrowed to one connection

> Proposed, not accepted. It reverses a position two documents hold —
> [commercial-model.md](../strategy/commercial-model.md) §5 ("keep connectors first-party / tightly
> admitted much longer than verticals") and [connections.md](../architecture/connections.md) §7
> ("a general connector marketplace … is a non-goal") — so it wants a human's ratification before
> the code it describes is relied on. The design is
> [vertical-connectors.md](../architecture/vertical-connectors.md).

**A vertical may declare its own connectors and ship them with `substrat push`, with no change to
this repository.** A vertical-defined provider is named `<namespace>.<name>`; first-party slugs never
contain a dot, so the two cannot collide. The platform keeps everything it holds for a first-party
connector — the sealed credential, the bindings, the connector state, the sweep schedule, the intent
drain, the probe routes — and runs the provider code **in the vertical's own worker**, called through
the router so the vertical's declared `outbound` hosts bound it (D-46). The code is handed a
`ConnectionContext` narrowed to one connection: its secret, a recorded `fetch`, its key/value state,
and on a scoped call the right to invoke operations in that scope as the connection principal. It is
never handed a `HostAdmin`, a `ScopeHost` or a tenant argument. **D-18's third bucket is unchanged in
kind** — a connector is still host code, never module code — **but "host" now includes the
vertical's own sandboxed worker**, not only the platform's. First-party connectors keep running in the
control plane as they do.

Publishing follows the vertical tiers of D-36: private to the declaring vertical (built), shared as a
package each importing vertical runs itself (built by construction), listed for other verticals
behind a staff review (designed, not built), first-party (as today).

## Why

The rule "connectors are first-party" protected against code that runs in the control plane with a
`HostAdmin`, which reaches every tenant. That is a property of **where** connector code runs and
**what it is handed**, not of who wrote it. Change both and the risk changes with them. A
vertical-defined connector in the vertical's own worker is only ever handed a credential the tenant
connected **for that vertical**, never another vertical's or another tenant's, and it writes only as
that connection under the grants the running version declares, which are in the permission digest.
What it does hold is the plaintext of that one credential: a tenant who connects it trusts that
vertical with it, as they already do when they paste one into the vertical's own UI through the
connection relay (connections.md §3.5.2). The declared `outbound` hosts bound the call that runs the
connector, not a secret the vertical has chosen to keep: egress from a Durable Object, or from a call
the control plane dispatches directly, carries no outbound policy (D-46, D-61). So its worst case is
what a vertical holding its own tenant's credential could already do. The caveat comes back in full only where a connector
would hold another vertical's tenants' credentials, which is the listed tier and is why that tier
waits for a staff gate.

Not taking this makes every provider a platform roadmap item, which is the ServiceNow trap the
commercial model names for a different reason. The trigger was a file-bearing source (#2614) whose
code was written outside this repository and needed only a registration here; the registration was
the only thing the platform contributed, and it was a deploy.

The two shapes considered and not taken: **registering outside packages in `CONNECTORS`** keeps every
provider a control-plane deploy and runs outside code with `HostAdmin`, which is the one combination
the old rule was right to refuse; **running the vertical's connector from the control plane's own
`dispatch.get(ref)`** would have skipped the egress worker, whose policy only the router's dispatch
binding carries, and handed a vertical's provider code unrestricted network.

## Limits and follow-ups

- The listed tier is not built: whether a listed connector's connection is keyed on the consumer, and
  how a consumer's permission diff shows writes from another vertical's code, are open.
- OAuth consent rounds, webhook ingress, mail senders and standing-grant healing are first-party only.
- State travels with each call and is capped (512 KiB, 2 000 keys); a provider whose index is larger
  is a first-party connector's job.
- The first-party connectors are not yet moved onto `ConnectionContext`.
- Connector standing grants move the permission digest but are not yet rendered in `PERMISSIONS.md`.
- Policy-free egress (Durable Objects, the control plane's own dispatches) is a follow-up.
