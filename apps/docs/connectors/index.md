# What is a connector?

A **connector** is the platform's bridge to a third-party service a *tenant* uses — Scrive for
e-signing, Fortnox for accounting, a BankID provider for identity. It is the one place in
Substrat allowed to talk to the outside world.

Connectors are **host code, never module code.** A vertical cannot call an external API: the
[boundary lint](/concepts/modules) bans `fetch` outright, and there is nowhere for a vertical to
keep a credential. That prohibition is the whole point — it means "this tenant's Scrive
account" lives in one audited place, and a vertical sees only the capability, never the secret.

## Where a connector sits

[Decision 18](https://github.com/substrat-run/substrat/blob/main/docs/master-plan.md)'s triage
rule sorts every outside dependency into three buckets, and a connector is the third:

| Bucket | What | Example |
|---|---|---|
| **Kernel-owned** | enforcement inputs and contracts | tenancy, permissions, the event spine, **the integrations hub itself** |
| **Adapter** | infrastructure the kernel consumes, swappable behind a pure interface | the SQLite/Cloudflare scope host, the `SecretBox` that seals credentials |
| **Connector** | a third-party capability tenants use, in the hub | **Scrive, Fortnox, BankID, Swish, Peppol, Kivra, EDI** |

The *hub* — the connection store, the runtime, the authority seam — is kernel-owned. Individual
connectors are not: they accrete one at a time, as a vertical needs one, and live in
`connectors/*` outside the kernel.

## The seam a connector plugs into

A connector never invents its own machinery. Four kernel-owned pieces do the load-bearing work,
and a connector is small because they exist:

1. **The connection store.** A tenant's authorization for one provider, held by one vertical,
   keyed **(tenant, vertical, provider)**. Credentials are sealed at rest by a `SecretBox`
   adapter — the metadata is readable, the secret never is. See
   [Permissions](/concepts/permissions) for how a connection becomes a subject.

2. **The connector runtime.** `registerConnector(id, eventType, handler)` binds a handler to an
   event. When a module emits that event, the runtime hands the handler an opened credential and
   a **`fetch` bound to the connection** — so a timeout, egress policy, and per-connection health
   recording come for free, and module code still cannot reach any of it.

3. **At-least-once delivery with retry.** The handler rides the same journal, backoff and
   dead-letter as every executor. A provider being briefly down is ordinary; the runtime retries
   with backoff and surfaces a dead letter rather than dropping the effect.

4. **The inbound authority seam.** A provider's callback is not a person, so it cannot hold a
   `PrincipalId`. Instead **a connection is a subject**: `getConnectorScope(connectionId,
   scopeId)` opens a scope stub whose authority is the connection's own grants, narrowed by
   construction to that tenant and vertical. Events it causes are stamped `{ connection }` on the
   spine — the audit trail says "Scrive did this" without naming a human who did not.

<ConnectorLoop />

## What a connector is *not*

- **Not an [engine](/engines/).** An engine owns invariants, operations, events and domain
  state inside a scope. A connector owns none of those — it *consumes* an event and *effects*
  something outside. It has no tables, no permissions of its own, no domain model.
- **Not swappable infrastructure.** The KMS behind `SecretBox` is an *adapter* (bucket 2). A
  connector is a capability a tenant deliberately connects, not plumbing the kernel picks.
- **Not a way around the module rules.** A connector cannot read a vertical's tables. If a
  connector needs a vertical's data, the vertical puts it in the event payload — the connector
  works from that and nothing else.

## Available connectors

Connectors accrete per vertical need, so this list is short by design and grows one entry at a
time. **Status** is honest: a connector can be documented and half-built, because the seam it
needs may not exist yet.

| Connector | Category | Status | Provider |
|---|---|---|---|
| [Scrive](/connectors/scrive) | E-signing & identity | **Published** ([npm](https://www.npmjs.com/package/@substrat-run/connector-scrive), `0.x`) — both halves built and running in production; two caveats: the vertical schedules the poll, and BankID is off on the testbed | Scrive eSign (Swedish BankID) |
| [Fortnox](/connectors/fortnox) | Accounting | **Built, unverified** (`0.x`) — poll-only, reads bookkeeping as SIE4; client-credentials auth, so no refresh token to rotate. Three claims still rest on documentation rather than a live call | Fortnox (Swedish accounting) |

Categories, as they will fill in (from the master plan's build list):

- **E-signing & identity** — Scrive, BankID, Kivra
- **Accounting** — Fortnox, Visma
- **Payments** — Swish
- **E-invoicing & EDI** — Peppol, Ahlsell / Rexel / Sonepar

## How these pages are organized

Every connector documents itself the same way — a different shape from an engine's five pages,
because a connector is a different thing. One page, these sections:

| Section | Answers |
|---|---|
| **At a glance** | provider, category, status, the npm package |
| **What it consumes** | the event that triggers it, and what the payload must carry |
| **The credential** | what the connection stores, and what must *never* be stored |
| **The flow** | what it does at the provider, step by step |
| **What's missing** | the seams it still needs — stated plainly, because an incomplete connector that pretends otherwise is worse than none |

If a connector cannot fill "What's missing" with an empty list, it is not done, and the page
says so.
