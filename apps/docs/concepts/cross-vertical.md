---
description: "Choose between peer calls, queued requests and event imports, with the permissions, transaction boundaries and recovery behavior of each."
---

# Cross-vertical communication

Two apps in the same tenant can work together while keeping separate databases and permissions.
A board-room app might read a customer's current details from a CRM, or keep its own index
up to date when the CRM announces a change. Those needs use different paths.

## Choose the path by what you need

| Need | Use | Where it runs | What comes back |
|---|---|---|---|
| Current data or an immediate operation result | **Peer call** with `peerClient` | The caller's host, outside a module transaction | The target operation's result or refusal |
| Ask another app to do work after your own write commits | **Queued peer request** with `ctx.requestPlatform` | An operation, consumer or schedule | An enqueue receipt; delivery happens later |
| React whenever another app records a particular fact | **Exported event + import handler** | The producer commits an event; the platform delivers it to the consumer | A local effect in the receiving app, tracked by a delivery journal |

Every path stays inside one tenant. Preview and fork scopes cannot be either end. A peer
acts as the calling **app**, not as the person using that app: the person's session and
permissions do not cross the boundary. Neither app gets SQL access to the other's tables.

Engines composed inside **one** scope are a different case: a vertical can call their
functions in its own transaction. See [engine composition](/engines/#star-topology-engines-never-talk-to-each-other).

## A call asks for a result

The board-room host calls the CRM's `customer/get`. The platform proves which app and
instance made the call, finds the target and enters its peer door. The CRM checks the
operation and permissions, runs it in its own scope, and returns its result.

<CommunicationFlow kind="peer" />

The declarations have different jobs:

| Declaration | Owned by | Meaning |
|---|---|---|
| `substrat.calls: ['acme/crm']` in package metadata | Board-room | This app intends to call the CRM |
| `peers` naming `acme/board-room` in the module manifest | CRM | This caller may invoke these operations with these permissions |
| Peer binding, when there is more than one target instance | Tenant admin, on the calling app | This instance of board-room calls that instance of CRM |

The target's declaration is the grant. Merely listing a target in `substrat.calls` gives
the caller no access. Permissions are seated when the target scope is provisioned or
re-provisioned; the target rechecks peer admission, the operation allowlist and the kill
switch on each call. Cutting off the peer takes effect on its next call and survives
re-provisioning.

**Two scopes still mean two commits.** A successful CRM write is not undone if the
board-room's later write fails. Design a multi-app workflow around durable requests and
observable outcomes; do not treat a chain of calls as one transaction.

Inside module code, enqueue the request instead of calling the network:

```ts
import { PEER_INVOKE_KIND } from '@substrat-run/contracts';

const requestId = ctx.requestPlatform({
  kind: PEER_INVOKE_KIND,
  payload: { vertical: 'acme/crm', operation: 'customer/list', input: { limit: 50 } },
});
```

That intent commits with the caller's write. A rollback leaves no request. Delivery is
at-least-once, keyed by the request ID; the returned ID is not a customer list. The target
is resolved **when delivery executes**, so changing a binding after enqueue changes where
the queued call goes.

For the manifests, host call and runnable two-host example, follow
[peer setup](/guide/architecture#calling-another-vertical-the-peer-door). The same page
lists [refusals and their remedies](/guide/architecture#the-refusals-and-what-each-means).

## An event announces a committed fact

The CRM commits `crm.customer-created` with its own row. Board-room imports that event
to maintain its own index. The producer declares `events.exports`; the consumer declares
`events.consumes` with `from`, `type` and `schemaVersion`, and registers its handler under
`imports`. An ordinary in-scope `consumers` handler does not subscribe to another app.

<CommunicationFlow kind="events" />

Both sides enforce authority. In the CRM, board-room must hold the export's read permission.
In board-room, the CRM arrives as the producing app and the import handler's permission
checks run under that identity. Declare both peers and the keys each side needs; a peer can
hold permissions with `operations: []` without exposing a directly callable operation.

Only payloads classified `piiClass: 'none'` may cross. Keep personal details behind the
producer's permission-checked operations, and do not put them into an exported event just
because another app wants a convenient copy. Delivery matches the event's type **and** schema
version. A withheld event is recorded with its reason, without handing its payload to the
handler. Cause chains are bounded at eight cross-vertical hops.

The PII label is a producer declaration, not a sanitizer. Export a deliberately non-personal
fact, such as the business category used for a count, rather than a copied customer profile.

The consumer owns a **watermark**: the producer event ID up to which it has read. Its
delivery journal records the handlers already run. Each handler's database writes commit
with its delivery record; the watermark advances after the batch. This makes normal
redelivery safe for recorded work without promising a transaction across the two apps.

| Situation | What happens | What to check |
|---|---|---|
| Consumer installed later | It reads the exported history from the start | Import handlers must handle historical facts |
| Either peer switched off | The edge pauses and its watermark holds | Restore access to resume the backlog |
| Consumer restored to an earlier snapshot | Its data, journal and watermark rewind together | Delivery catches up with what the restore undid |
| Operator requests replay | The selected delivery records are moved aside and handlers run again | External effects can repeat; acknowledgement is required |
| Operator skips forward | The watermark moves past work without applying it | Skipping cannot target a time in the future |
| Import handler throws | Its writes roll back; a dead letter records the failure and later events can proceed | Waiting alone does not retry the handler; investigate before replaying |
| Version or PII classification does not match | The event is withheld and recorded as a dead letter | Fix the contract and explicitly decide what to replay |

A routed response can kick delivery within seconds. Commits from schedules, peer calls
and imports rely on the sweep as the backstop. The edge-health view distinguishes caught
up, behind, paused, unresolved and unavailable; a failed read is not an empty backlog.

## Instance selection and deployment changes

Peer calls can use a caller-instance binding when a tenant has several instances of the
target. Event delivery currently requires a unique primary instance of each vertical.
**A peer binding does not choose the source of an event stream.** An unresolved event edge
needs its instance topology corrected, not a retry of the peer-binding UI.

Promoting a version that removes or re-versions an export used by an installed consumer
requires export-break acknowledgement. Schema compatibility checks also reject incompatible
payload changes at an unchanged version. Individual `bindScopeVersion` changes do not yet
have the export-break gate, so check affected consumers before using that path.

See [export/import declarations](/guide/architecture#between-verticals-exports-and-imports),
[peer permissions](/concepts/permissions#another-app-of-the-same-tenant-peers), and the
[cross-vertical contract suite](/reference/contract-tests) for the underlying contracts.
