---
id: D-81
date: 2026-11-28
layer: plan
title: "A connection's credential is bound to the host its connector declares, and is never sent to another"
status: proposed
aliases: []
amends: ["D-64"]
tracking: ["#3465", "#3463"]
---

# D-81 — A connection's credential is bound to the host its connector declares, and is never sent to another

> **Proposed 2026-11-28**, from [rfc/broker-and-tenant-isolation.md](../rfc/broker-and-tenant-isolation.md)
> §8.3. It waits for the owner. It is decided now because it holds whoever injects a credential
> later. The injection itself (Track D, #3476) is not decided here.

**A connector declares, per credential field, the host it is sent to, and the platform sends it to
that host only.** The declaration sits beside the connector's `fields` (`docs/architecture/vertical-connectors.md`
§5): a field marked `secret: true` names the host, and optionally the methods and path prefixes,
it may accompany. A credential is never part of a request to any other host, whichever of the
vertical's declared `outbound` hosts that request goes to.

**Until the platform injects credentials, the rule is held where the credential is handed out.** A
vertical-defined connector receives the plaintext in `ConnectionContext.secret` today (D-64). The
platform's half is the `ConnectionContext.fetch` it hands with it: that fetch refuses a request to a
host the credential is not bound to when the request carries a value of that credential (in a
header, the URL or the body), and records the refusal as a use of the connection. This is a
tripwire, not a boundary: code holding the plaintext can still send it another way, which is why
D-64 says the vertical holds it.

**Once the platform injects credentials (Track D), the binding is what the injector reads.** The
outbound worker adds a credential only to a request whose host, method and path the binding admits,
and the connector's code never sees the value. The same binding then carries the guarantee instead
of the tripwire.

**A push refuses a connector whose secret field names no host**, or names a host the version's
`outbound` does not declare, in the same words `lint:connector-grants` uses. First-party connectors
declare their bindings the same way, so the console can show, per connection, where its credential
goes.

## Why

**Declaring a second host is otherwise enough to take a credential elsewhere.** D-46 bounds where a
vertical's requests go, not which credential rides on which request. A vertical that declares its
provider's API and any other host can, today, send the provider's token to the other one, and the
egress worker admits it, since both hosts are declared. Binding the credential to its host closes
that path for the platform's own fetch now, and for every request once the platform injects.

**It is cheap to decide before injection exists, and expensive after.** Every connector shipped
before the binding would need its declaration added before its credential could be injected, and a
missing one would be a connector that cannot run. Declaring it now, while there are few
vertical-defined connectors, makes the later move a change of who reads the binding, not a
migration of every connector.

**The tripwire is stated as one.** While the vertical holds the plaintext, no runtime check can stop
code that means to send it elsewhere; a check on the handed-out `fetch` catches the mistake and the
lazy path, and records it where the tenant's connection health already shows uses. Calling it more
would repeat the overstatement D-58 corrected for D-46.
