---
status: proposed
layer: plan
description: "A connector is its own deployable unit with one call contract, and where it runs is a choice. Phase 1 is a pilot: Bolagsverket as its own script in the dispatch namespace, called by the control plane through the router behind a flag, TEST only, to measure the extra hop. D-73 records the direction as proposed."
---

# RFC: connectors as their own scripts

**Status: proposed.** The direction is agreed with the owner as a direction, not decided:
[D-73](../decisions/D-073-a-connector-is-its-own-deployable-unit-with-one-call-contract.md) records it
as proposed. Phase 1 is a **pilot to measure**, not a rollout: it runs one connector out of process,
in the test environment only, behind a flag that is off everywhere. **Extends:**
[D-64](../decisions/D-064-a-vertical-may-define-its-own-connector-and-it-runs-in-the-vertical-s-worker.md)
and [vertical-connectors.md](../architecture/vertical-connectors.md) (the call contract).
**Follows, where it fits:** the store-driver scripts of D-63, D-65, D-67, D-69 and D-70.

## 1. Problem

Every first-party connector runs inside the control plane. Its code is a dependency of the control
plane, it is handed a `ScopeHost` whose `HostAdmin` reaches every tenant, and adding, changing or
rolling back one is a control-plane deploy. A connector's fault — a hung provider, a memory spike, a
dependency with a vulnerability — is a fault of the worker that holds every tenant's directory.

Store drivers already left: a driver is its own script in the dispatch namespace, reached by the
router, holding no platform authority (D-63, D-70). Vertical-defined connectors run in the vertical's
own worker, handed one connection per call (D-64). First-party connectors are the last provider code
that runs with the whole platform in reach.

## 2. Direction (proposed, D-73)

- **A connector is its own deployable unit, with one call contract.** The contract is D-64's:
  `connectorCallRequest` → `connectorCallResponse`, one shape per role (`probe-candidate`, `probe`,
  `bind`, `sweep`, `dispatch`). A first-party script speaks the same roles over the same response,
  with a plain provider slug instead of a dotted one (`connectorScriptCallRequest`).
- **Placement is a choice, not a kind.** The same connector may run as a platform script or inside a
  vertical's worker (D-64). Which one is a registration fact, not a different interface.
- **Connectors stay stateless.** They return state writes; the control plane applies them, under the
  scope's lease where a scope is involved — the fenced batch write of #3158. A connector never opens
  storage of its own.
- **The platform keeps credential custody.** A connector is handed the one credential a call needs, in
  the call, or (later) a per-connector secret binding. It never reaches the control plane's storage.
- **Egress only through the hop, only to declared hosts.** The router dispatches the script with an
  outbound policy, and the egress worker holds every provider call to it (D-46).
- **The contract evolves additively**, like an engine surface: a field is added optional, a role is
  added, nothing is renamed or narrowed.

## 3. Phase 1: the pilot

### 3.1 What runs where

```
control plane            opens the credential; later records the uses the script reports
  │ CONNECTOR_CALLS.callScript(target, request)
  ▼
router                   DISPATCH.get('substrat-connector-bolagsverket', { outbound: { OUTBOUND_POLICY } })
  │ POST /internal/connector-probe
  ▼
script                   probes with the credential in the call; answers the probe and its uses
  │ fetch (token mint, ping)
  ▼
egress worker            admits only the hosts in OUTBOUND_POLICY
  │
  ▼
Bolagsverket
```

- **The script** is `connectors/bolagsverket/src/script.ts`, deployed by its own `wrangler.jsonc`
  into the dispatch namespace as `substrat-connector-bolagsverket`. It declares **no binding at all** —
  no storage, no secret, no var, no service — and the suite fails if one appears. It serves
  `probe-candidate` and `probe` on the probe path. Another path is a 404, another method on the
  probe path a 405, and another role, provider or configuration a 400.
- **The router** gains `ConnectorCalls.callScript(target, request)` beside `call`. It parses the
  target (`connectorScriptCallTarget`: the script, the tenant to meter, the hosts) and the call, refuses
  a scoped role, a script that is not the provider's, or a connection of another tenant, and dispatches
  with `OUTBOUND_POLICY = { slug: <script>, tenant, hosts, scope: '' }`. The empty scope gives the
  script no identity at the relay, a peer or a store; the slug meters its egress under its own name.
  It sends no platform secret and no signed envelope: the script holds nothing a caller could reach
  through it, and every value it uses arrives in the call.
- **The control plane** keeps Bolagsverket's registration. With `bolagsverket` in
  `REMOTE_CONNECTORS`, the two probes go through the script (`placedProbes` in
  `apps/control-plane/src/connector-scripts.ts`); without it they run in-process, exactly as before.
  The credential summary (a read of the platform's own store) and the sweep (a no-op that calls
  nothing) stay in-process either way. So does the organisation lookup dispatch, added after the pilot
  shipped: `dispatch` is a scoped role, which phase 1 does not carry (§3.5), so "its operations" here
  are the probes.

### 3.2 Credentials and configuration travel per call

A `probe` opens the tenant's live connection in the control plane, as the in-process probe does, and
sends `connection.secret` in the call; a `probe-candidate` sends the pasted secret. The deployment's
configuration — the provider environment and any host overrides — travels too, as `config`, so the
script holds no configuration either, and the egress hosts the router admits are derived from the
same values the script will call (`bolagsverketEgressHosts`). The script builds a fresh client per
call, so no token outlives the request it was minted for. The uses it made come back in the answer,
and the control plane records them against the connection it opened.

### 3.3 Refusals keep their meaning across the hop

A credential the provider refuses is `refused: true`, as in-process. Anything that is the
platform's failure — no route, a script that is not deployed (503 after the router's one retry), a
call the script or the router refuses (400), an answer that is not the contract, a provider call the
egress worker refuses (its 403 marked `x-substrat-egress: refused`) — is `ok: false, refused: false`
with the reason, never a refused credential.

### 3.4 The name space

`substrat-connector-<provider>` is reserved in `@substrat-run/contracts` (`CONNECTOR_SCRIPT_PREFIX`),
as `substrat-store-` is: `platformScriptCollision` refuses a vertical slug whose stem falls inside it,
so a vertical can never deploy under a connector's name in the shared namespace, and the router never
dispatches a connector call into a vertical.

### 3.5 What phase 1 does not do

- **No release pin.** The script is deployed by an operator with wrangler, not uploaded by the control
  plane against a reviewed sha256 (D-63) or an approved release (D-65). A connector release follows
  the store-driver route before any production placement.
- **No scoped roles.** `bind`, `sweep` and `dispatch` are refused by the router and the script. They
  need the scope lease and the state application of §2, which Bolagsverket does not exercise.
- **No connector state** crosses the call; Bolagsverket keeps none. A script that answers state writes
  is treated as a failure.
- **The egress refusal text names a vertical's `package.json`.** It is the vertical's message, and
  reads wrongly for a connector script; the refusal itself is right.
- **The script authenticates nobody.** It is reachable only through the router's dispatch, which only
  the control plane's binding drives, and it holds nothing. A connector that holds a secret binding
  (§4) needs the router's signed envelope (K-58) first.

### 3.6 Measurement

`PROBE_CONNECTOR_HOP` (a control-plane var, unset everywhere) runs each probe both ways, in a random
order, answers from where `REMOTE_CONNECTORS` places it, and writes one `connector-hop-probe` log line
per call: each side's wall clock, the provider's share of it (the sum of its calls' durations), and
`hopMs`, the extra time beyond the provider. The shadow side calls the provider and records no use.
The same comparison runs locally as an opt-in probe (`SUBSTRAT_PROBE_CONNECTOR_HOP=1` on the control
plane's suite), which with every hop in one process measured a floor of about 1 ms median, 2 ms p90.
The figure that decides anything is the log line from the test environment.

### 3.7 Trying it on the test environment, and turning it off

1. Merge, so the router and the control plane in TEST carry `callScript` and the flag (their normal
   deploys; the flag is off).
2. Build the script's workspace dependencies, then deploy it:
   `pnpm --filter @substrat-run/connector-bolagsverket... build`, then
   `pnpm --filter @substrat-run/connector-bolagsverket cf:deploy:test`
   (`wrangler deploy --dispatch-namespace substrat-verticals-test`). The script imports
   `@substrat-run/kernel` and `@substrat-run/contracts`, which resolve from their built `dist`.
3. Turn the flag on for TEST only: add `"REMOTE_CONNECTORS": "bolagsverket"` (and, to measure,
   `"PROBE_CONNECTOR_HOP": "bolagsverket"`) to `env.test.vars` in `apps/control-plane/wrangler.jsonc`,
   in a reviewed change the test deploy carries. A var set by hand in the Cloudflare dashboard works
   too, until the next deploy of the control plane replaces the vars with the file's.
4. Press **Test connection** on a Bolagsverket connection, or paste a candidate pair, and read the
   `connector-hop-probe` lines from `substrat-control-plane-test`'s logs.

To turn it off, remove **both** vars, `REMOTE_CONNECTORS` and `PROBE_CONNECTOR_HOP` (or let the next
deploy drop hand-set ones): with `REMOTE_CONNECTORS` alone removed, the answer is in-process again but
the hop probe still calls the script for its comparison. Once the control plane runs without either
var, every call is in-process and there is nothing else to undo. Only then delete the script, if
wanted, from the `substrat-verticals-test` namespace in the Cloudflare dashboard.

## 4. Later phases

**Mock profile.** Once a connector is a script, a second deployment of the same code can answer from a
recorded profile instead of the provider, selected per environment or per scope. Previews and forks
(#2005, already inert) and CI then exercise the real connector code and the real call contract against
a profile, instead of hand-stubbed provider hosts in each suite, and a builder can run a connector they
hold no credential for.

**Local cloud proxy.** `substrat dev` reaches the hosted connector scripts through an authenticated
proxy, so a vertical running on a laptop uses the real connector with a credential that never leaves
the platform: the proxy opens the connection and makes the call, exactly as the control plane does.
Nothing on the laptop holds the secret, and the dev loop needs no copy of the connector.

**A stateful second connector.** The second pilot is one with a sweep and a dispatch — Planima or
WooCommerce, whose state is small — to exercise `sweep`, `dispatch` and `bind` over the contract: the
script returns state writes and recorded uses, and the control plane applies the writes fenced on the
scope's lease (#3158), as it already does for a vertical-defined connector. This is the phase that
proves "stateless" holds for a connector that has state, and the first that needs the router's
signed envelope on the script's door.

**Vertical placement.** With one contract, placing a first-party connector inside a vertical's worker
(D-64) is a registration choice: the same package is mounted by `defineConnectors` there, and the
control plane resolves where to call by the registration instead of by the provider's spelling. A
vertical that wants a connector's code close to its own (no extra hop, its own `outbound`) takes it;
the platform keeps the credential and the bindings either way.

**Catalog and third-party.** A connector script is a release like a store driver's: registered here,
its bytes uploaded and approved by a person (D-65), canaried and rolled back. A catalog lists them,
and a third-party connector is admitted through the same gate a third-party store driver is, with the
isolation of D-70 — its own loaded isolate, no network but the hop — standing between its code and
every tenant's credential it is handed.
