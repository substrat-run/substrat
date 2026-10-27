---
status: building
layer: plan
description: A vertical defines its own connector, ships it with substrat push, and the platform runs it in the vertical's worker.
---

# RFC: vertical-defined connectors

**Status:** building. **Decision:** [D-64](../decisions/D-064-a-vertical-may-define-its-own-connector-and-it-runs-in-the-vertical-s-worker.md)
(proposed). **Extends:** [connections.md](./connections.md) §4 (the connector interface) and §4.2
(where it runs). **Leaves for later:** the listed tier of [§8](#8-publishing--the-marketplace-tiers).

## 1. Problem

Every connector is a first-party package registered in `CONNECTORS`
(`apps/control-plane/src/connectors.ts`), mirrored by the dashboard's `PROVIDERS` catalog, and held to
it by `lint:connector-grants`. A new provider is a dependency, a registry entry and a control-plane
deploy. A builder who needs a provider the platform does not ship — a regional document box, a
sector system with a dozen customers — has no way in short of asking us.

The interfaces are not what stops them. `ConnectorSweeper`, `ConnectionBinder` and
`ConnectorHandler` are injected; the drivers depend on no specific connector. Three things stop them:

1. **A connector is handed the whole platform.** A sweeper receives a `ScopeHost`, a dispatch
   handler `ctx.admin: HostAdmin`. Both reach every tenant. The shipped connectors use five
   directory verbs (`openConnection`, `recordConnectionUse`, and get / put / list connector state)
   and three scope verbs (`connectionGrantsInScope`, `getConnectorScope(…).invoke`,
   `getConnectorAttachments`). The breadth is the reason a connector must be first-party.
2. **It runs in the control plane,** so adding one is a control-plane change.
3. **The provider list is written down in three places,** none of which a vertical can reach.

## 2. Decision in one paragraph

A vertical declares connectors in its own source and ships them with `substrat push`. The platform
keeps every piece of state and authority it holds today — the sealed credential, the bindings, the
connector state, the sweep schedule, the intent drain, the probe routes — and, for a
vertical-defined provider, calls **into the vertical's own worker** to run the provider code, handing
it a capability narrowed to one connection. The call is dispatched by the router, so the vertical's
declared `outbound` hosts (D-46) bound what its connector can reach. First-party connectors are
unchanged.

## 3. Why the trust argument holds

`docs/strategy/commercial-model.md` §5 keeps connectors first-party because *"a third-party connector
is a credential-exfiltration and reportable-breach surface"*. That is true of code running **in the
control plane with `HostAdmin`**. A connector a vertical defines for itself, running in its own
worker, is a different and much smaller surface:

- Connections are keyed `(tenant, vertical, provider)` (§3.1.1). The platform only ever hands a
  vertical's connector a connection made **for that vertical**, never another vertical's and never
  another tenant's.
- The call that runs it is dispatched with the vertical's declared `outbound` allowlist, enforced by
  the egress worker.
- What it writes, it writes by invoking operations **as the connection principal**. The
  connection's standing grants come from the **running version's** declaration (the platform
  ignores grants a caller supplies for a vertical-defined provider), and they are part of the
  permission registry and its digest.

What this does **not** claim, stated so nobody relies on it:

- **The vertical holds the plaintext.** That is the design: its code is the code that uses the
  credential. A tenant who connects one is trusting that vertical with it, whether they paste it
  into the vertical's own UI (the relay, connections.md §3.5.2) or into the dashboard's form. The
  second door is new: before this, a credential entered on the dashboard never reached a vertical.
- **The outbound allowlist bounds the connector call, not the secret.** Once the vertical holds a
  secret it can persist it (connector state round-trips through the platform; its own Durable
  Object and attachments too), and egress from a Durable Object or from an invocation the control
  plane dispatches directly carries no outbound policy (D-46's documented gap; D-61 observes
  Durable-Object egress and never refuses it). Closing those paths is a follow-up, not something
  this design delivers.
- **Health is self-reported.** The uses a call records come back in the vertical's answer.

So the risk is the one a tenant already takes in choosing a vertical: its code, with a credential
the tenant gave it. What the platform guarantees is the boundary around that — no other tenant's or
vertical's credential, no `HostAdmin`, writes only as the connection under reviewed grants. The
caveat returns in full where a connector would hold credentials connected for **another** vertical
— the listed tier (§8), which is not built here.

## 4. Naming: a dot marks a vertical-defined provider

A provider is `connectionProvider`: a lowercase slug. A vertical-defined provider is
**`<namespace>.<name>`**, both halves plain slugs (`acme.docbox`). First-party slugs never contain a
dot, so the two can never collide, and a first-party connector added later can never start
receiving a vertical's connections.

The namespace is the author's choice, like an npm scope. It is not the vertical's slug (a slug may
carry `/`, which a provider in a URL path cannot), and the platform never resolves anything from it:
which vertical a connection belongs to is already on the connection row. Two verticals that import
the same connector package both declare `acme.docbox`, and their connections stay apart because the
key includes the vertical.

## 5. What a vertical writes

### 5.1 The declaration and the code, in one value

A connectors entry module, named by `substrat.connectors` in the vertical's `package.json`, exports
`connectors`:

```ts
// src/connectors.ts — host code, never module code
import { defineConnectors } from '@substrat-run/vertical-host/connectors';

export const connectors = defineConnectors({
  'acme.docbox': {
    label: 'DocBox',
    description: 'The document box an accounting firm shares with its client.',
    fields: [
      { key: 'company', label: 'Company code', secret: false },
      { key: 'user', label: 'User', secret: false },
      { key: 'password', label: 'Password', secret: true },
    ],
    grants: ['documents:land'],          // the connection's standing grants
    events: ['documents.files-requested'], // routed to dispatch()
    async probeCandidate(secret, { fetch }) { … },   // before the credential is stored
    async probe(ctx) { … },                          // the live connection
    async bind(ctx, options) { … },                  // optional: validate binding options
    async sweep(ctx) { … },                          // optional: the poll floor, per bound scope
    async dispatch(ctx, event) { … },                // optional: one routed event
  },
});
```

`substrat push` imports the module, reads the static half (`connectors.declarations()`), validates
it (§7.1) and sends it in the manifest. The worker mounts the same value:
`mountPlatformSurface(app, { …, connectors })`. A vertical whose modules emit a declared event
routes it with `declareConnectorEvents(host, connectors)` on its scope host, so the delivery
becomes a `connector:<provider>` intent as a first-party routed connector's does.

Probes are **required**, as #1326 requires them of first-party connectors: a connection a tenant
cannot test is a door that 501s.

### 5.2 The capability a connector is handed

Defined in `@substrat-run/kernel` (`connection-context.ts`), implemented by `vertical-host`:

```ts
interface ConnectionContext {
  readonly connection: {
    id: ConnectionId; provider: string; tenantId: TenantId; vertical: string;
    externalAccountRef: string | null; expiresAt: string | null;
  };
  /** The credential the tenant connected. This connection's, nothing else. */
  readonly secret: Readonly<Record<string, string>>;
  /** Deadline-bound; every call is recorded as a use of this connection (health, §3.7). */
  readonly fetch: FetchLike;
  /** Key/value state: the connection's own on a probe, the scope's own on a scoped call (never both). */
  readonly state: {
    get(key: string): Promise<unknown | undefined>;
    put(key: string, value: unknown | null): Promise<void>;   // null deletes
    list(prefix?: string): Promise<{ key: string; value: unknown }[]>;
  };
}

interface ScopedConnectionContext extends ConnectionContext {
  readonly scope: { tenantId: TenantId; scopeId: ScopeId; operation: string | null; options: Record<string, unknown> };
  /** Invoke the binding's landing operation as the connection principal. */
  land<O = unknown>(input: unknown): Promise<O>;
  /** Invoke any operation as the connection principal; its grants decide. */
  invoke<O = unknown>(operation: string, input?: unknown): Promise<O>;
  readonly attachments: {
    upload(input: ConnectorUploadInput): Promise<AttachmentRecord>;
    open(attachmentId: string): Promise<OpenedAttachment | null>;
  };
}
```

There is no tenant argument, no scope host and no admin. A connector that throws
`ConnectorRefusal` fails terminally (an intent settles `failed`, a probe answers `refused: true`);
any other throw is retried by whoever called it.

## 6. How the platform runs it

### 6.1 The platform owns the bindings

For a first-party connector, the connector writes its own binding records into connector state. For
a vertical-defined one, **the platform does**: a binding is `{ scopeId, operation, permission,
options, declared, boundAt }`, stored under the reserved key `vc:binding:<scopeId>`. The connector's
optional `bind(ctx, options)` hook only validates and normalises `options` (resolve a folder path to
an id, say) before the platform writes the record. `declared` keeps the options as the landing
supplied them, and the landing pass compares against it — otherwise a hook that normalises would
re-bind on every pass.

This is forced, not chosen. A tenant's scopes can run different versions (installs pin, previews
fork), and each version has its own Durable Object class. A sweep that invoked every bound scope
from one call would reach some of them through the wrong script. So a sweep is **one call per bound
scope, dispatched to that scope's own deployment**, and the platform — which knows the bindings —
makes those calls. The connector gets simpler for it: it says how to read and how to land, and keeps
no binding bookkeeping.

Bindings come from the same two doors a first-party connector's do: the landing pass, from a
module's declared `connections` (#2316), and the staff binding door
(`PUT …/connections/:id/bindings/:scopeId`).

### 6.2 State travels with the call

The connector's state for the call — the connection-level keys for a connection-level call, the
scope's keys (stored under `vc:state:<scopeId>:`) for a scoped one — is sent **in** the request.
The connector reads and writes an in-memory copy; its writes come back **in** the response and the
platform applies them only when the call succeeded. A connector that throws leaves state as it was,
so a sweep cursor never advances past work that did not land. Delivery is therefore at least once,
keyed by whatever the connector keys its items by — the same contract as `file-source.ts`.

State is capped: `CONNECTOR_CALL_STATE_MAX_BYTES` (512 KiB serialised) and
`CONNECTOR_CALL_STATE_MAX_KEYS` (2 000) — on each call's writes, and on the **total** a connection or
scope holds once they are applied. A call whose writes would take the total over either cap applies
nothing and fails, so state never grows past what the next call can carry. A provider whose index
outgrows that (a Microsoft 365 drive) is a first-party connector's job; a document box of a few
hundred items fits.

Two limits, stated: writes are applied key by key, so a platform fault partway through applying
them can leave some applied (the call is then reported failed and re-run); and a sweep and a
dispatch on the same scope each work from their own snapshot, so a key both write is
last-writer-wins. A connector keys what a sweep and a dispatch each own apart.

### 6.3 The call

```
control plane ──CONNECTOR_CALLS──▶ router.ConnectorCalls ──DISPATCH.get(ref, outbound: policy)──▶ vertical
                                                         POST /internal/connector-probe | -call
```

One request/response, `connectorCallRequest` → `connectorCallResponse` in `@substrat-run/contracts`
(`vertical-connector.ts`), discriminated on `role`:

| role | path | sent to | carries | answers |
|---|---|---|---|---|
| `probe-candidate` | `/internal/connector-probe` | the vertical's serving deployment | the candidate secret | `connectionProbe` |
| `probe` | `/internal/connector-probe` | the vertical's serving deployment | connection, connection state | `connectionProbe` |
| `bind` | `/internal/connector-call` | the scope's deployment | connection, scope, raw options | normalised options |
| `sweep` | `/internal/connector-call` | the scope's deployment | connection, binding, scope state | `{ landed, more }` |
| `dispatch` | `/internal/connector-call` | the scope's deployment | connection, binding or null, event, scope state | nothing |

Two paths because of wire signing (K-58). A scoped role changes the scope, so its envelope names
tenant and scope and spends a nonce in that scope's store. A probe names no scope, changes nothing in
the vertical (its state writes come back in the answer), and so is replay-free
(`WIRE_REPLAY_FREE_CALLS`). Each path serves only its own roles, and the router refuses a target whose
scope does not match the role's shape, or whose vertical is not the connection's.

Every answer carries the connector's state writes and its recorded uses; the platform applies the
writes, records the uses against the connection (`recordConnectionUse`), and settles the caller —
the sweep report, the intent, the probe route — from `ok`, `refused` and `error`.

**Why the router dispatches it.** Only the router's `DISPATCH` binding names the egress worker. A
`dispatch.get(ref)` from the control plane passes no outbound policy, so a connector run from it
would reach any host. The router's `ConnectorCalls` entrypoint (beside `PeerCalls` and
`ScopeStoreCalls`) dispatches with `OUTBOUND_POLICY = { slug, tenant, hosts, scope, … }`, the hosts
being the target version's declared `outbound`. The entrypoint is reachable only through the control
plane's `CONNECTOR_CALLS` service binding, so the policy it is handed is the platform's.

**Authentication** is the platform surface's own: both paths sit behind `mountPlatformSurface`'s
platform-secret gate, and `wireEndpoint` admits the router as a signer on exactly these two paths and
`/internal/vertical-invoke`.

### 6.4 Where the platform looks a provider up

Every site that today indexes a `Record<provider, …>` built from `CONNECTORS` keeps doing so, and
falls back, for a provider containing a dot, to the vertical connector proxy:

| Site | Today | Fallback |
|---|---|---|
| cron connector pass (`runPlatformSweep`) | `sweepers[provider]` | `sweeperFor(connection)` |
| landing pass (`connectionLandings`) | `binders[provider]` | `binderFor(connection)` |
| intent drain | `handlers['connector:<p>']` | `handlerFor(kind)` |
| inspection routes (`verify`, `bindings`, `activity`, `credential`) | `connectionInspectors[provider]` | `inspectorFor(provider)` |
| connection relay probe | `connectionInspectorsFor(env)[p]?.probeCandidate` | the same `inspectorFor` |

The proxy resolves the declaration from the **running version's stored manifest**
(`connectorsOfManifestJson`), never from a cache of the latest push, so a promote that drops a
connector stops it at the next call. A connection whose provider the running version no longer
declares fails its call with a reason naming that, and its bindings are left in place for a later
version that declares it again.

## 7. The door and the gates

### 7.1 Push

`substrat push` (and `--check`) refuses a declaration that:

- names a provider without a dot, or declares one twice;
- carries a standing grant the vertical does not declare, or one a module reserves to a system
  principal (`reservedKeyOffences`, #2430);
- routes an event type none of its modules emits;
- lacks `probe` or `probeCandidate`.

The control plane re-parses the manifest (`deployManifest`) and repeats the reserved-key refusal,
since the CLI is the builder's machine.

A connector's standing grants are lifted into the permission registry (`registry.connectors`), so
they move the permission digest a promote acknowledges, and `push --check` prints them. They are
**not** yet rendered into a vertical's `PERMISSIONS.md`: `lint:permissions` builds from the
vertical's modules and roles and never loads the connectors entry. Until it does, a reviewer sees a
widened connector grant in the digest and the CLI's output, not in the checked-in file.

### 7.2 The dashboard door

The dashboard reads a vertical's declared connectors off its registry record (the latest push, as
`requires` already is) and renders the credential form from `fields`. A vertical that declares a
connector requires it; nothing else lists it. Connecting is refused unless the **serving** version
declares the provider, and the standing grants are that version's declaration's — never the latest
push's and never the caller's — applied when the connection is created or its credential updated. A
promote does not revisit existing connections (standing-grant healing, §9). A live connection whose provider no declaration names any more stays
listed and revocable: a tenant can always withdraw a credential. `lint:connector-grants` keeps
checking the first-party pairs, and refuses a dotted slug among them; the vertical-defined ones are
checked at push.

## 8. Publishing — the marketplace tiers

The vertical tiers carry over (`marketplace-publish.md` §2, D-36): self-serve while the audience is
your own team; the human vouch where it widens.

| Tier | Who can bind it | Where the code runs | Gate | Built |
|---|---|---|---|---|
| Private | the declaring vertical's own connections | that vertical's worker | push validation | **yes** |
| Shared as a package | any vertical that imports it | each importer's own worker | none — each importer runs its own copy under its own `outbound` and grants | **yes**, by construction |
| Listed | other verticals, through `provides: ['connector:<provider>']` / `requires` | the providing vertical's worker | staff review at listing | no |
| First-party | everyone | the control plane | adopted into this repo | as today |

The listed tier is where the old caveat applies in full: a listed connector would hold credentials
connected for other verticals' tenants, and write into their scopes. Two questions are open before it
can be built: whether the connection stays keyed on the consumer with the code run from the provider,
and what the consumer's permission diff shows for writes that arrive from another vertical's code.

## 9. Out of scope

- **OAuth consent rounds.** The platform owns those `redirect_uri`s. A vertical-defined OAuth provider
  needs its own client and a token-refresh hook. Pasted credentials first.
- **Webhook ingress.** Poll first, as connections.md §5 did.
- **Mail senders** (#2098) and **certificates.**
- **Standing-grant healing** (`reconcileConnectionGrants`). A vertical-defined connection carries its
  grants from the door that created it; healing them is a follow-up.
- **Porting the first-party connectors** onto `ConnectionContext`. They keep `HostAdmin` until a
  separate change moves them.
- **Self-host in-process running.** The proxy takes its transport as a parameter, and the node suites
  run it in-process; wiring that into a self-hosted deployment's sweep is a follow-up.

## 10. Open questions

1. **Version skew.** Bindings outlive a promote that drops a provider (§6.4). Should the landing pass
   tombstone them instead, as it does for an un-declared landing?
2. **Cost and quotas.** Sweeps are platform-initiated invocations of a tenant's worker. They should
   count against the vertical's quotas; today they are metered as connector calls only.
3. **Sweep continuation.** `more: true` is recorded but the pass makes one call per binding per run;
   a long backfill catches up over several passes.
4. **`PERMISSIONS.md`.** Render `registry.connectors` there (§7.1), which means teaching
   `lint:permissions` to load a vertical's connectors entry.
5. **Policy-free egress.** Route the control plane's own calls into a vertical, and Durable-Object
   egress, through the egress policy, so §3's second caveat can be removed.
