---
'@substrat-run/contracts': minor
'@substrat-run/kernel': minor
'@substrat-run/adapter-sqlite': minor
'@substrat-run/adapter-cloudflare': minor
'@substrat-run/contract-tests': minor
'@substrat-run/vertical-host': minor
'@substrat-run/boundary-lint': minor
'@substrat-run/console': patch
'@substrat-run/dashboard': patch
---

One vertical can now call another vertical's operations in the same tenant. The platform identifies the calling app, so it holds no token and needs no pasted API key, hostname or outbound allowlist entry (#1706, part 1: the kernel half).

**The target declares who may call it.** A module manifest can declare `peers`: another vertical's registry slug, the operations that vertical may invoke, and the permissions it holds while doing so.

```ts
peers: [{ vertical: 'acme/board-room', operations: ['customer/list'], permissions: ['customer:read'] }]
```

- **The keys are seated at provisioning** as `vertical:<slug>` grants, the way a schedule's `system:<module>` grants are.
- **`lint:permissions` renders them** in a new PERMISSIONS.md section, so widening what another app may do shows up in the reviewed permission diff. It also refuses a peer key or operation that no module declares.
- **`operations: []` declares a receive-only peer.** It holds its keys and can invoke nothing.
- **`permissions: []` is refused.** A peer entry that grants nothing declares nothing.

**The caller is an actor of its own.** `@substrat-run/contracts` adds `verticalActor` (`{ vertical, scope }`: the calling app and the instance that called) to the actor union, and a `{ kind: 'vertical' }` check subject. It also adds `peer.ts`, which holds `verticalCaller`, `peerSpec`, `verticalInstance`, `verticalResolution`, `peerSwitch` / `peerSwitchResult` / `peerSwitchOutcome`, `peerCoverage`, and the `VerticalSlug` type. `adminAction` gains `revokeFromPeer` / `restoreToPeer`.

**`@substrat-run/kernel` adds the peer door and its supporting verbs:**
- **`ScopeHost.getVerticalScope(caller, tenantId, scopeId)`**, the sixth door. Every invoke is admitted inside the scope (`admitPeer`): the caller must be a declared peer, its switch must be on, and the operation must be on its allowlist. A refusal is `forbidden`, and it is not a K-35 denial. Inside, the operation is ordinary: checks resolve the declared grants, and events and denials name `{ vertical, scope }`. No principal crosses, and a peer cannot mint a capability.
- **`ScopeHost.peerCovers`** reports whether a peer holds each key right now, using the checker's own answer.
- **`HostAdmin.resolveVerticalInstance(tenantId, vertical)`** finds "the instance of vertical Y in tenant T". It applies one rule, `resolveVerticalInstanceFrom`: a primary, active scope of that tenant, exactly one. Otherwise the answer is `not-installed` or `ambiguous`, never a guess.
- **`HostAdmin.revokeFromPeer` / `restoreToPeer`** are the per-(scope, peer) kill switch. It runs the schedule switch's own statement, now generalised as `switchSubjectGrants`. OFF tombstones the peer's grants and blocks the provisioning seat, so the next call is refused and nothing a re-provision does brings the grants back.

These are REQUIRED members of `ScopeHost` and `HostAdmin`, so every implementation in or out of tree needs them. The shared rules are exported from `peer.ts`.

**Both adapters implement all of it.** On the Durable-Object path, the coordinator threads the caller to the ScopeDO, which admits it in its queue on every invoke and acknowledges it. The coordinator refuses a success the DO did not acknowledge, the capability session's skew pattern.

**`@substrat-run/vertical-host`** adds `/internal/vertical-invoke`, which takes a strict body naming the caller and nothing that could act as a person, and `/internal/peer-switch`. Both sit behind the platform secret, like every `/internal` verb. They use two OPTIONAL `VerticalScopeHost` methods, and a deployment built before them answers 501.

**`@substrat-run/adapter-sqlite/vertical-broker`** is the pure host's stand-in for the platform hop. It lets two verticals run side by side locally under the same model. It is a node-only subpath (the `workerd`/`worker`/`browser` conditions resolve to nothing).

**`@substrat-run/boundary-lint` R9** refuses importing that subpath anywhere but a test, `server.ts` or `seed.ts`.

**`@substrat-run/contract-tests`** adds `peerContractSuite`, `verticalResolutionContractSuite` and the `peerMod` fixture.

**The console's denial log and the dashboard's history strip** name a peer as the app it is.

Not in this release: the hosted transport (the router hop that identifies the calling deployment, and the caller's `calls` declaration), the dashboard controls for the switch, and a binding for a tenant that runs two instances of one vertical.
