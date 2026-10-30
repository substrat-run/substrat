# @substrat-run/vertical-auth

## 0.28.10

### Patch Changes

- Updated dependencies [f0e000d]
- Updated dependencies [0bc0f4a]
  - @substrat-run/contracts@0.170.0
  - @substrat-run/kernel@0.170.0

## 0.28.9

### Patch Changes

- Updated dependencies [9e6412c]
- Updated dependencies [77d504f]
- Updated dependencies [fb2de85]
  - @substrat-run/contracts@0.169.0
  - @substrat-run/kernel@0.169.0

## 0.28.8

### Patch Changes

- Updated dependencies [e34da92]
  - @substrat-run/contracts@0.168.0
  - @substrat-run/kernel@0.168.0

## 0.28.7

### Patch Changes

- Updated dependencies [280f175]
  - @substrat-run/contracts@0.167.0
  - @substrat-run/kernel@0.167.0

## 0.28.6

### Patch Changes

- Updated dependencies [9499b29]
  - @substrat-run/contracts@0.166.0
  - @substrat-run/kernel@0.166.0

## 0.28.5

### Patch Changes

- Updated dependencies [7df34ee]
  - @substrat-run/contracts@0.165.0
  - @substrat-run/kernel@0.165.0

## 0.28.4

### Patch Changes

- Updated dependencies [170078f]
- Updated dependencies [3225234]
- Updated dependencies [0e2bc1c]
- Updated dependencies [0b19237]
- Updated dependencies [2ade7ea]
- Updated dependencies [af79679]
- Updated dependencies [1e5a5af]
  - @substrat-run/contracts@0.164.0
  - @substrat-run/kernel@0.164.0

## 0.28.3

### Patch Changes

- Updated dependencies [ad35e20]
- Updated dependencies [60eb041]
- Updated dependencies [2eedfee]
  - @substrat-run/kernel@0.163.0
  - @substrat-run/contracts@0.163.0

## 0.28.2

### Patch Changes

- Updated dependencies [3310b4d]
- Updated dependencies [7d71f13]
  - @substrat-run/kernel@0.162.0
  - @substrat-run/contracts@0.162.0

## 0.28.1

### Patch Changes

- Updated dependencies [d52ad61]
- Updated dependencies [7d34c2c]
- Updated dependencies [1e7e16e]
- Updated dependencies [8bb7be5]
- Updated dependencies [2dfc19b]
- Updated dependencies [5279112]
- Updated dependencies [91a5ea1]
- Updated dependencies [81a07aa]
- Updated dependencies [14ce171]
  - @substrat-run/kernel@0.161.0
  - @substrat-run/contracts@0.161.0

## 0.28.0

### Minor Changes

- bc51fe0: Stop writing hash-only member invites, and announce when the accept side stops. `createInvite` (and the identity directory's method of the same name) now requires the `become` capability id the invite's link is, and refuses a missing or empty one before anything is written, so no new hash-only row can be created. Every route in this package and in vertical-host already passed one. A caller that passed `null`, or left the argument out, now fails to compile, and an untyped call throws.

  `createLegacyInvite` in `@substrat-run/vertical-auth/member-directory` is the explicit way to write a hash-only row. It exists for test fixtures that cover the rows still pending, takes the directory's SQL handle rather than being a method of the identity directory, and is removed with the legacy branch.

  Hash-only invites that are already stored still accept by their hash for now. `claimInvite`'s legacy branch stops admitting in the first vertical-auth release published on or after 2027-01-09, at least 90 days after 2026-10-11, when the last route that wrote a hash-only invite stopped doing so. Before that release, the platform counts the hash-only invites still pending on hosted scopes and withdraws any that remain. An invite that is still outstanding then needs to be sent again. `legacyInviteCount` and the `legacy-invites-pending` log line keep reporting what is left.

### Patch Changes

- Updated dependencies [8e8af88]
- Updated dependencies [f0b5904]
- Updated dependencies [763957c]
- Updated dependencies [361136b]
- Updated dependencies [581a697]
- Updated dependencies [dc3b911]
- Updated dependencies [a283098]
- Updated dependencies [95bdb79]
- Updated dependencies [26db572]
- Updated dependencies [5554dad]
- Updated dependencies [279f8e8]
- Updated dependencies [c304fbd]
- Updated dependencies [69868f3]
- Updated dependencies [5147141]
- Updated dependencies [a06e284]
- Updated dependencies [ee05879]
- Updated dependencies [9112dd6]
- Updated dependencies [78a0c96]
- Updated dependencies [09c081a]
- Updated dependencies [ecbed6e]
- Updated dependencies [d5f2f9a]
- Updated dependencies [bc36021]
- Updated dependencies [286f3b4]
- Updated dependencies [5f75359]
- Updated dependencies [bc629db]
  - @substrat-run/contracts@0.160.0
  - @substrat-run/kernel@0.160.0

## 0.27.2

### Patch Changes

- 6aad0fb: Record bounded, credential-free authentication checks on request invocation logs. Bearer verification distinguishes invalid issuer/audience, expiry, signature, discovery/key failures and app/delegation policy refusals; MCP records caller-resolution outcomes and early refusal problem codes. Request details show these checks, including a verified token followed by a caller refusal. Authentication responses and admission policy are unchanged.

  Upgrade and re-push a vertical with the updated auth and host packages to produce the diagnostics. Older lines remain readable and do not imply authentication succeeded.

- Updated dependencies [6aad0fb]
  - @substrat-run/contracts@0.159.0
  - @substrat-run/kernel@0.159.0

## 0.27.1

### Patch Changes

- @substrat-run/contracts@0.158.0
- @substrat-run/kernel@0.158.0

## 0.27.0

### Minor Changes

- 156febd: Discover the per-instance sign-in issuer through the standard auth route by default when mounting MCP. Publish protected-resource metadata and challenge unauthenticated clients with its URL, so team-auth-server clients can register themselves without per-vertical discovery wiring. Existing deployments must update both host and auth packages and redeploy. Explicit issuer overrides, audience validation, and operation permissions are preserved.

### Patch Changes

- Updated dependencies [d0af665]
- Updated dependencies [156febd]
  - @substrat-run/contracts@0.157.0
  - @substrat-run/kernel@0.157.0

## 0.26.1

### Patch Changes

- Updated dependencies [8bbf7e9]
- Updated dependencies [c5052f9]
- Updated dependencies [55a4dae]
- Updated dependencies [1344288]
  - @substrat-run/kernel@0.156.0
  - @substrat-run/contracts@0.156.0

## 0.26.0

### Minor Changes

- 8122e15: Remove the unused built-in Better Auth email/password provider from IdentityDO. OIDC workers no longer pull Better Auth or Drizzle into their bundles. Authentication continues through the configured OIDC issuer; the per-tenant identity directory, ownership, invites, sites, scope configuration, and OIDC session secret remain intact.

  The former doAuthProvider export and IdentityDO HTTP authentication surface are removed. Consumers must use oidcAuthProvider or oidcRpAuthProvider. Existing credential tables are left untouched, but are no longer created or used; the separate auth-server keeps its credential handling.

### Patch Changes

- Updated dependencies [6933146]
- Updated dependencies [35bdba2]
- Updated dependencies [10b7e03]
  - @substrat-run/contracts@0.155.0
  - @substrat-run/kernel@0.155.0

## 0.25.3

### Patch Changes

- Updated dependencies [bf18880]
- Updated dependencies [34c4455]
- Updated dependencies [34c4455]
- Updated dependencies [1872bb7]
  - @substrat-run/contracts@0.154.0
  - @substrat-run/kernel@0.154.0

## 0.25.2

### Patch Changes

- Updated dependencies [1a064a0]
  - @substrat-run/kernel@0.153.0
  - @substrat-run/contracts@0.153.0

## 0.25.1

### Patch Changes

- Updated dependencies [482e9b7]
  - @substrat-run/contracts@0.152.0
  - @substrat-run/kernel@0.152.0

## 0.25.0

### Minor Changes

- e829918: Delegated calls at a vertical's MCP endpoint: another app of the team acting for a user, with a token the team auth server minted by RFC 8693 token exchange.

  `@substrat-run/vertical-auth`: a bearer carrying `act` is now refused on every configuration unless the vertical opts in with `delegation: { actors }` (on `instanceAuthFor`, `selectAuthProvider`, `oidcRpAuthProvider` or `oidcAuthProvider`). On `instanceAuthFor`, `actors` may be a list or a function of the install's delivered wiring (`{ identity, config }`). A resolver that throws, or returns nothing usable, admits no delegated token.

  `AuthProvider.resolve` takes an optional third argument, `{ delegated }`: the MCP endpoint's channel, `mcpChannelOf(c)` from `@substrat-run/vertical-host`. A delegated token is admitted only through it. An admitted token must:

  - name a listed actor of this issuer;
  - be issued to that actor;
  - carry a non-empty `scope`;
  - carry an `iat` no more than 30 seconds ahead of the verifier's clock;
  - live no longer than five minutes (`exp − iat`; `maxLifetimeSeconds` can lower that, never raise it);
  - have exactly the channel's resource as its only `aud`, on the request's own origin.

  A call without the channel refuses it. That covers a REST route, a stray handler, and `resolve(headers)` alone. The resolved `AuthSubject` then carries `delegation: { actor, scope }`.

  Two other refusals apply on every configuration:

  - A token carrying a `substrat_delegation` claim but no `act` (the token exchange's intermediate assertion) is never accepted as a bearer.
  - On a shared issuer, a token whose `aud` is another app's MCP endpoint is refused even when it was issued to this app's own client. This includes this app's own endpoint on another of its hostnames, and any spelling of the endpoint (case, trailing slash, percent-encoding).

  `@substrat-run/vertical-host`: `mountMcp` sets a channel for the span of its own `resolveStub` call, and `mcpChannelOf(c)` reads it (`null` everywhere else, and nothing a request sends can set it). `setMcpDelegation(c, subject.delegation)` hands the admitted delegation back. Every `tools/call` is then refused, in-band and before the operation runs, unless the tool's leading permission key is in the delegated scope. A tool with no single leading key (`narrows`) is outside every scope. If a bearer carries `act` and no delegation was handed over, every tool call is refused.

  Every route `mountOperations` mounts answers a bearer carrying `act` with a `401`, before resolving the caller.

  The MCP endpoint is now the only route at its path:

  - A route registered before it that Hono would dispatch there, by any method but `OPTIONS` (`/mcp`, `/:slug`, `/:slug?`, a regex parameter), now throws at mount.
  - A second `mountOperations` on the same base path now throws at mount too, because the first endpoint is already there.
  - The endpoint answers every method but `OPTIONS` itself: `POST` is MCP, and anything else is a `405`. A route registered after it never runs there.
  - Not judged: `app.use`, `app.all` and `app.mount`, `OPTIONS` routes, and `*` catch-alls.

  `McpTool` gains `permission`, the leading key.

### Patch Changes

- 5436493: Every `405` the MCP endpoint answers carries `Allow: POST`, as RFC 9110 requires, so a client can learn which method is served there.

  A delivered `audience` is checked on a delegated token too, so one that is not the MCP endpoint's resource admits no delegated token. That still fails closed. The bearer verifier now logs a warning when a host that opted in to delegation on a shared issuer has a delivered `audience` and the MCP endpoint's channel names another resource. It warns once per isolate for each issuer and audience, and names the field, not its value.

  The MCP endpoint's mount-time check now judges earlier routes against the path the endpoint really answers at, including an `app.basePath()` prefix. A route on a `basePath` app that would answer there now throws at mount, and a root route at the unprefixed path no longer does, since it is not in the way.

  Every refusal of a mount is now judged before `mountOperations` or `mountMcp` registers anything, so a refused mount leaves the app as it was. That covers a route already at the endpoint's path, one of the mount's own operations there, an operation no registered module provides, and two operations whose names render as one MCP tool name (such as `desk/a.b` and `desk/a/b`). The error names the mount that raised it.

  **Behaviour change:** a `*` is now judged as Hono's `TrieRouter` reads it, wherever it is. #2398 skipped every pattern with a segment that is exactly `*`. Now a route with a `*` segment that `TrieRouter` dispatches to the endpoint's path throws at mount when it is registered before the mount with a method. That covers `*`, `/*`, `/api/*`, `/api/mcp/*`, `/*/mcp` and `/*/*`, so a `GET *` fallback is among them. A `*` segment that misses the path, such as `/other/*`, is not refused, and `/api/mc*` still is.

  Remedy, one line: register the fallback after the mount (`mountOperations(app, …)` first, then `app.get('*', …)`), or make it middleware (`app.use('*', …)`, which is not judged) that answers only once `await next()` has found nothing.

  Not judged, and stated:

  - `app.use`, `app.all` and `app.mount`, and `OPTIONS` routes.
  - The routes of an app this one is later mounted into with `app.route()`.
  - The `*` forms that the default router dispatches there and `TrieRouter` does not match. Hono's routers do not all agree on `*`, so these are not refused: a `*` inside a segment, such as `/api/*cp`, and a pattern ending in two or more `*` segments that reaches the path only if its last `*` matches nothing, such as `/api/*/*` or `/*/*/*` (`/*/*` matches `/api/mcp` segment for segment, and is refused).

- Updated dependencies [8273013]
- Updated dependencies [4efc88d]
- Updated dependencies [a667881]
- Updated dependencies [f614b00]
- Updated dependencies [a00c87a]
  - @substrat-run/contracts@0.151.0
  - @substrat-run/kernel@0.151.0

## 0.24.5

### Patch Changes

- Updated dependencies [6b22e85]
- Updated dependencies [57700ea]
- Updated dependencies [52cc41f]
- Updated dependencies [9024575]
- Updated dependencies [5f77e74]
  - @substrat-run/oidc-rp@0.13.0
  - @substrat-run/kernel@0.150.0
  - @substrat-run/contracts@0.150.0

## 0.24.4

### Patch Changes

- Updated dependencies [98f09fe]
- Updated dependencies [0292dc0]
- Updated dependencies [b190e40]
- Updated dependencies [eda31d1]
- Updated dependencies [5aaf0f5]
- Updated dependencies [af096c6]
- Updated dependencies [39ccfea]
- Updated dependencies [6f5f12b]
- Updated dependencies [754fc62]
- Updated dependencies [c7eb5fa]
- Updated dependencies [1df1b93]
- Updated dependencies [6c1e359]
- Updated dependencies [439efc1]
- Updated dependencies [e550dec]
- Updated dependencies [4574ab8]
- Updated dependencies [3025154]
- Updated dependencies [9ae6644]
- Updated dependencies [d6ba289]
- Updated dependencies [2e503da]
- Updated dependencies [3608db6]
- Updated dependencies [9ceb545]
  - @substrat-run/kernel@0.149.0
  - @substrat-run/contracts@0.149.0
  - @substrat-run/oidc-rp@0.12.0

## 0.24.3

### Patch Changes

- 24ae42f: A federated logout with a `returnTo` no longer fails at the issuer with `Invalid post_logout_redirect_uri`. Issuers match that URI exactly against the client's allowed logout URLs, so a `returnTo` that differs per request (an invite link's `/invite/<token>`) could never be registered. The issuer is now given one fixed URL, `/api/auth/logged-out`, and the path the person was heading for waits in a short-lived `sb_oidc_return` cookie until they arrive there (same-origin paths only). A logout with no `returnTo` still sends `/` as before. `oidc-rp` exports `federatedLogout`, `LOGGED_OUT_PATH` and `LOGOUT_RETURN_COOKIE`, and `vertical-auth` serves the new route. **Action:** register `<origin>/api/auth/logged-out` as an allowed logout URL on the OIDC client. `safePath`, the guard every `returnTo` goes through (login, logout and the new route), now also refuses ASCII control characters: a tab or newline is stripped by a URL parser before it resolves, so `/<TAB>/host` was an open redirect.
- Updated dependencies [ad3ca19]
- Updated dependencies [c4a0352]
- Updated dependencies [f855218]
- Updated dependencies [24ae42f]
- Updated dependencies [a8b0842]
- Updated dependencies [00253e0]
- Updated dependencies [a9cbb6d]
- Updated dependencies [7f8c6bf]
- Updated dependencies [d175d87]
- Updated dependencies [1bf5425]
  - @substrat-run/contracts@0.148.0
  - @substrat-run/kernel@0.148.0
  - @substrat-run/oidc-rp@0.11.1

## 0.24.2

### Patch Changes

- Updated dependencies [9926c53]
- Updated dependencies [8ff761c]
- Updated dependencies [cb957bc]
- Updated dependencies [cb957bc]
- Updated dependencies [4d14a81]
- Updated dependencies [5b1c20f]
- Updated dependencies [1ce756e]
- Updated dependencies [b854efd]
- Updated dependencies [23840a7]
- Updated dependencies [1ad1426]
- Updated dependencies [b4bb938]
- Updated dependencies [cb957bc]
  - @substrat-run/contracts@0.147.0
  - @substrat-run/kernel@0.147.0

## 0.24.1

### Patch Changes

- Updated dependencies [381f120]
- Updated dependencies [a55d75e]
- Updated dependencies [56b0af0]
  - @substrat-run/contracts@0.146.0
  - @substrat-run/kernel@0.146.0

## 0.24.0

### Minor Changes

- c8525e8: Measure the legacy hash-only invites still pending (#2175).

  `IdentityDO.legacyInviteCount(scopeId)` counts a scope's unclaimed invites that carry no capability — the rows only the legacy branch of `acceptMemberInvite` can still serve. The invite routes write a `legacy-invites-pending` warn line (`scopeId`, `pending`, `via`; no address, token or principal): from `GET /api/invites` only while `pending` is above zero and at most once an hour per scope per isolate, and from every accept that claims an invite through the legacy branch. An hour with no line means nothing is left to retire only once count support is confirmed (without `legacyInviteCount`, or when the count cannot be read, a list read emits no measurement) and the list reads succeeded for every relevant scope. Additive: `legacyInviteCount` is optional on `InviteDirectory`, and `legacyInviteListReporter` is exported for a door that lists invites itself.

### Patch Changes

- Updated dependencies [e786ff0]
- Updated dependencies [f49cc49]
- Updated dependencies [6aaf822]
- Updated dependencies [bb4f18d]
- Updated dependencies [2c75a0d]
- Updated dependencies [48e9503]
- Updated dependencies [5554b23]
- Updated dependencies [3782c4c]
- Updated dependencies [fac4f0a]
  - @substrat-run/contracts@0.145.0
  - @substrat-run/kernel@0.145.0

## 0.23.0

### Minor Changes

- 835409e: Binding invites: a `become` link can also bind its claimant to their own record (#1686).

  A customer invite is not delegation. It does not hand someone a share of the inviter's authority. It binds the person who claims it to their own record: a contact, a customer, an employee. The rights that come with that record are declared in the vertical's model, reviewed at the permission checkpoint, and never carried by the link. The link names only which record.

  - **The declaration.** An `ENTITY_GRANTS` shape gains an optional `bind: { permission }`. It is valid only on a `bootstrap` shape whose `holder` is the table form (`{ table, idColumn, principalColumn }`), and the permission must be a declared key that is not one of the shape's own current or retired keys. Whoever holds that ordinary key on a record may invite its person with a link, and may unbind them. The holder column should be one of the entity's erasure subjects, not an `erasable` field, and its `idColumn` should be unique. A binding shape's keys are refused to every direct grant on a record of its type, as a `'grantee'` shape's are. A grant on a parent entity of another type is not refused yet; #2177 tracks that. Once a scope has recorded a binding shape for a type, the type's keys stay refused to direct grants there, whatever later versions declare. The record is made at the first reconcile that carries the declaration, and it covers a key a later version adds to the shape. That is permanent and per scope, and it fails closed by design:
  - A vertical that removes the binding shape and wants those keys plain-granted again must use new key names. A retirement takes the keys back from their holders but does not lift the refusal, and nothing clears the scope's `shape-bound` record.
  - A scope the binding was never declared in is unaffected. `PERMISSIONS.md` gets a column for it, and the version-to-version diff says when a shape gains or loses a bind (`grantChanges[].bind`, and a holder note). Omitted when unset, so a registry that binds nothing keeps its digest.
  - **The reconcile records it.** Each reconcile records the reached registry's binding shapes in the scope (holder column, bind key, current keys) beside the grantee keys, on its first pass. The claim and an unbind read that record, never the vertical's code, so a scope not yet reconciled with a binding declaration binds nothing. A version that drops `bind` but keeps the shape with the same table holder keeps the holder recorded. Only the bind key goes, so nobody can mint, claim or unbind, and an erasure still releases. The Cloudflare host now runs the pass for a registry with no shapes too, so a version that drops its last grantee or binding shape stops refusing direct grants and stops binding on that host as well.
  - **The mint.** `principalBecomeCapabilityInput` takes an optional `bind: { entity }`. Besides the existing bound on the target, the host's bounded mint refuses with nothing written: `bind-not-declared` (no binding shape for that type in the scope's reconciled registry), `bind-record-missing`, `bind-record-ambiguous` (more than one row of the holder table carries the record's id), `bind-record-bound` (a row with the record's id already names a person; refused, never re-bound), `bind-record-held` (the column names nobody, but someone already holds the record's shape, for example a person given it before the column was written: unbind them first), and a `coverage` naming the bind key when the minter does not hold it on that record. The link carries the action in a new nullable column, `_substrat_capabilities.action` (JSON `capabilityAction`, `{ kind: 'bind', entity }`), which both adapters add to existing scopes on start. A `become` capability record carries it as `action`, so the operator's capability list and the console card show a bind link as one. `capability.become-minted` gains an optional `action` field. A bind link's holdings digest is stored as `bind:<digest>`, so a host from before this change, which reads no `action`, fails its digest compare and refuses the link (revoking it as `holdings-changed`) instead of spending it as a plain `become`.
  - **The claim is one transaction.** The exchange judges the bind again before it takes the use: the binding still declared, the record there and naming nobody, the minter still holding the key on it. Any refusal is the exchange's one refusal (`null`) and leaves the link unspent. A link whose minter has lost the key, or left, is refused this way. After the use is taken, in the same transaction, the record's column is set to the claimant, the shape is granted (its marker and current keys), and a new kernel-authored event, `entity.holder-bound` v1, goes on the record's history with the capability as actor. The column write is counted by `RETURNING` and must touch exactly one row. It is never counted by `changes`, which on a Durable Object counts index entries too. A failure inside any of it rolls the use back too. The exchange's answer gains `bound: <entity>`.
  - **The unbind.** A new bounded host verb, `unbindEntityHolderBounded(tenantId, scopeId, caller, entity)`, on `SqliteScopeHost` and `CloudflareScopeHost`. The caller must hold the bind key on the record. It clears the column on every row with the record's id. It then releases every holder of the shape on the record from the spine, not from the column: each live marker, and everything its holder holds on the record. That includes whoever a link bound even if module code has since rewritten the column, a key the shape dropped without retiring it, and a holder given the shape before the column was written. It also revokes a direct grant of a key outside the shape that was made to that holder on that record, and reports it in `removed`. Each release writes one `entity.holder-unbound` v1 (the caller as actor). The verb answers `boundedUnbind`: `{ ok: true, unbound: <principal>[] }`, a `coverage`, or `bind-not-declared`. vertical-auth mounts it for any vertical as `mountUnbindRoute(app, deps)`, at `POST /api/bindings/:entityType/:entityId/unbind` (403 naming the key, 404 for a type the scope does not bind).
  - **Erasure unbinds.** It covers every type the scope binds now or has ever bound. The first reconcile that records a binding shape writes a sticky spine record, `(shape:<type>, shape-bound)`. No reconcile removes it, and module code cannot write it. The erased subject's id is matched against every such type, as a module's declared erasure matches its subject columns whatever the type, so ids that are not ULIDs (integers, say) can collide across types. The erasure reads two things before any module erasure runs: the holders on the record that is the erased subject, and the erased person's own markers, plus the rows whose column names either. After the module hooks, in the same transaction, it releases each holder from the spine and clears the column where the row survived and the holder is still recorded. A hook can still find rows by the binding column, and a record a hook or a `delete` removed is released all the same. The erasure writes no event for this, since an event naming the erased subject would be a new copy of it.
  - **People already bound keep the shape until they are released**: by an unbind while the shape binds, by an erasure, or by retiring its keys. That holds whatever a later version does to the declaration. A version that drops `bind` leaves no unbind. One that removes the shape or moves its holder leaves erasure and retirement, and #2178 tracks refusing such a version at push.
  - **Kernel.** `unbindEntityHolderBounded`, `ENTITY_UNBIND_OPERATION`, `allowedFor`. `becomeMintCheck` takes an optional `bind`, and `exchangeCapability` an optional `allowed` dep (the checker's `check`, for the minter).
  - **Not reached.** A link the bind would now refuse still lists as `open` in `becomeLinkStates`. Its state reflects the holdings digest, not the bind.

### Patch Changes

- Updated dependencies [835409e]
- Updated dependencies [f84eb3a]
- Updated dependencies [e286f87]
- Updated dependencies [f6d671b]
- Updated dependencies [134e6c2]
- Updated dependencies [6dc8097]
  - @substrat-run/contracts@0.144.0
  - @substrat-run/kernel@0.144.0

## 0.22.1

### Patch Changes

- dfb653b: An operator can revoke a capability on a hosted scope (part of #1686). Before this, the platform's `revokeCapability` refused every scope served by a vertical's own deployment, so a leaked link share could be seen in the console but not stopped.

  - `HostAdmin.revokeCapability` on the shared control plane now reaches the deployment that serves the scope, through a new `capabilityDelegation` option on `CloudflareScopeHost`. The admin log row stays on the control plane, and the record names the operator as its revoker. With no delegation configured, a hosted scope is still refused `unavailable`.
  - `HostAdmin.revokeCapability` is audited intent-then-outcome on both adapters, as the kill switches are (kernel `auditedCapabilityRevoke`; `revokeCapability` joins `AUDITED_CHANGE_ACTIONS`). An intent row lands before anything is revoked. Then the outcome is one of:

    - `applied`, with the record as it stood;
    - `refused`, when the scope holds no such capability, or the deployment refused or predates the route;
    - nothing yet, when the answer was lost or named another capability. The scheduled settle then closes the intent as `unknown`.

    So a revoke that landed is never missing from the admin log.

  - `provesNothingChanged` now lives in `@substrat-run/contracts`. `@substrat-run/control-plane-client` re-exports it unchanged.
  - `mountPlatformSurface` mounts `POST /internal/capabilities/revoke`, behind the platform secret like the rest of `/internal/*`. It answers `{ before }`: the record as it stood, or `null` when the scope holds no such capability. That answer is never a 404, because a 404 is how a deployment built before this route says so. `VerticalScopeHost` gains `revokeCapabilityLocal`.
  - **Breaking:** `CloudflareScopeHost.revokeCapabilityLocal` now returns the record as it stood (`CapabilityRecord | null`) instead of a boolean. A check against `null` still works. A check of `=== true` does not.
  - `VerticalClient.revokeCapability` makes the call. A deployment built before the route answers 501 "redeploy the vertical", and nothing is revoked. An answer lost in transit is a 502 that says to read the capabilities before retrying.
  - The control-plane API gains `POST /tenants/:t/scopes/:s/capabilities/:id/revoke`, staff only like the capability read, with `revokeCapability` on the staff client. It answers 204, and again for a capability already revoked. It answers 404 for a capability the scope does not hold.
  - `contracts` gains `capabilityRevokeRequest` and `capabilityRevokeAnswer`.
  - The console's Capabilities card has a Revoke button, with a confirm, on every capability still acting: live ones, and used-up ones whose sessions keep acting until they expire.

- Updated dependencies [e55e06c]
- Updated dependencies [7eb1b3c]
- Updated dependencies [7eb1b3c]
- Updated dependencies [e55e06c]
- Updated dependencies [dfb653b]
- Updated dependencies [f1c6c9a]
- Updated dependencies [6c44d57]
- Updated dependencies [9454e61]
  - @substrat-run/contracts@0.143.0
  - @substrat-run/kernel@0.143.0

## 0.22.0

### Minor Changes

- 65305a1: Member invites are `become` capabilities (#1686).

  The link an invite hands a new teammate used to be a token whose hash the identity directory kept on its own. It is now a `become` capability in the scope's own Durable Object, minted by the member who invites: it works once (`maxUses: 1`), can be revoked, and its mint and its use are on the scope's spine. What an invite does for people is unchanged. It still never expires, the role is still granted when the invite is made, a withdrawal still stops it, and accepting still answers one refusal for every failure.

  - **Who may mint one.** A principal mints a `become` capability only through the host's bounded verb, and only while it holds everything the target principal holds at the scope: every permission the target holds at the node (scope or tenant level, through its orgs), and every entity-narrowed grant the target holds must be one the minter can exercise on that entity. The check and the write are one scope task, and a refusal writes nothing. Two more refusals: a target holding nothing at the node (`target-holds-nothing`), since an empty set would cover trivially, and a target some `become` link has already been exchanged into in this scope (`target-already-claimed`). A member invite meets neither, since it grants the role first and mints for a principal it has just created. An invite at a role that confers no permission at all now answers `409`.
  - **The link dies when its principal's holdings change.** The mint records a digest of what the target holds: the role keys as assigned, the direct grants and the entity-narrowed grants, at both levels and through its orgs. The exchange recomputes it. If anything changed (a role assigned or taken away, a grant added or removed, an org joined or left), the link is revoked with no revoker and refused, taking no use. A role's definition is deliberately not in the digest: it is the vertical's code, so a release that adds a key to a role does not kill every open invite at it. The minter is not re-checked at the exchange.
  - **A dead link shows as dead.** The kernel's own revoke records its reason in a new nullable column, `_substrat_capabilities.revoked_reason` (`holdings-changed`), carried on capability records as `revokedReason`. A new host read, `becomeLinkStates`, answers open, used, expired or revoked with the reason for each link. It judges a principal-minted link as its exchange would, so one whose principal changed reads as revoked (`holdings-changed`) before anyone tries it, and nothing is written on the read. One call names at most `BECOME_LINK_STATES_MAX_IDS` (100) links and refuses more rather than truncate; both lists ask in pages of it. Both pending-invite lists (`GET /api/invites` and the platform's member roster) show each invite's `link`, and the dashboard marks a dead one.
  - **Who may revoke one.** The kernel bounds the revoker itself: the link's minter, or someone holding everything its principal holds now. A refusal writes nothing, and the host verb answers `{ ok, revoked }` or the coverage.
  - **Contracts.** `principalBecomeCapabilityInput` (the expiry is optional), `boundedBecomeMint`, `becomeMintRefusal`, `boundedBecomeRevoke` and `becomeLinkState`; `scopeMemberInvite` gains an optional `link`; and a new kernel-authored event type `capability.become-minted` (`capabilityBecomeMintedPayload`, v1), whose actor is the minter and whose entity is the capability. `capability.minted` is unchanged.
  - **Kernel.** `becomeMintCheck`, `holdingsDigest`, `readBecomeLinkStates`, `mintBecomeCapabilityAsPrincipal` and `revokeBecomeCapabilityAsPrincipal`. `Holdings` carries the role keys and direct grants beside the expanded permissions. `_substrat_capabilities` gains nullable `target_digest` and `revoked_reason` columns, which both adapters add to existing scopes on start. `exchangeCapability` takes an optional `holdings` dep. `PermissionChecker` gains an optional `holdings` (what a subject holds at a node, node-level and entity-narrowed), which the built-in evaluator implements. A checker without it makes the bound refuse.
  - **Adapters.** `SqliteScopeHost` and `CloudflareScopeHost` gain `mintBecomeCapabilityBounded`, `revokeBecomeCapability` and `becomeLinkStates`. Both are host methods, not module verbs. The revoke reaches only a `become` that a principal minted, never an `act` share or the platform's own claim link.
  - **vertical-auth.** `mountInviteRoutes` takes four more deps, `mintBecomeCapabilityBounded`, `revokeBecomeCapability`, `exchangeCapability` and `becomeLinkStates`, and refuses to create or withdraw an invite without the first two. `mintMemberInvite` grants the role, mints the link and records it, undoing the link and the grant if the record fails. `acceptMemberInvite` and `withdrawMemberInvite` are the shared accept and withdraw. `IdentityDO` gains `inviteMatches`, `inviteLink` and `claimInviteByCapability`, and its invite rows carry `capabilityId`; `withLinkStates` joins them to where each link stands. `createInvite` takes the capability id. A withdrawal revokes the link before it deletes the row, so a failed revoke leaves the row for the retry. The `invite` table gains a `capability_id` column, which the DO adds to existing storage on start.
  - **vertical-host.** `/internal/members/invite` mints the link the same way, and `/internal/members/remove` revokes the link of the invite it withdraws. The host must have the two new verbs, or the member routes answer 501.
  - **Invites minted before this release** still accept by their hash, through `claimInvite`. Unlike an owner claim link, an invite never expires, so that path stays until those invites are accepted or withdrawn.

  Re-push a vertical that mounts the invite routes to move its new invites onto capabilities.

- 65305a1: The legacy owner-claim redeem path is gone (#1686).

  Since the release that made owner claim links `become` capabilities, a link minted the old way, by hash, was only redeemed until it expired, 15 minutes after it was minted. That path is now removed: `claimOwner` on `IdentityDO` and in `owner-seat`, and the hash branch of `mountOwnerClaim`. A token that is not a capability secret gets the one refusal and reaches neither the directory nor the scope. `migrateOwnerSeat` drops the old `owner_claim` table from existing storage.

### Patch Changes

- Updated dependencies [6a81de3]
- Updated dependencies [c78098a]
- Updated dependencies [65305a1]
- Updated dependencies [c56bb34]
  - @substrat-run/contracts@0.142.0
  - @substrat-run/kernel@0.142.0

## 0.21.1

### Patch Changes

- Updated dependencies [48be1e6]
- Updated dependencies [51bb25b]
- Updated dependencies [6a05977]
  - @substrat-run/contracts@0.141.0
  - @substrat-run/kernel@0.141.0

## 0.21.0

### Minor Changes

- 0e3d406: - kernel: `checkedWithin(entity, permission)` narrows a live read to one root, gated by the subscriber's own check on that root rather than on each row. The check runs at the handshake (`403`, `x-substrat-live: forbidden`) and again on every pass that has something beneath the root to announce. A withdrawn grant, or a root moved out of the grant's reach, closes the socket before anything is sent. Frames are bare nudges, as for `vouchedWithin`. Use it whenever there is a grant to check; `vouchedWithin` stays for a subscriber with none.
  - adapter-cloudflare: the scope's fan-out honours `checkedWithin`, asking each socket's gate at most once per pass and only when a row beneath its root is about to be announced.
  - kernel: `subscribe` takes `expiresAt`, the instant the caller's credential ends. The scope refuses a handshake past it and closes the socket (`1008`) on its first pass past it, before sending anything, or at its own alarm on a scope nobody writes to. An expired socket never counts against a principal's socket limit. One principal may hold `LIVE_SOCKETS_PER_PRINCIPAL` (8) sockets on a scope; the next is closed `LIVE_CLOSE.tooMany` (`4429`), which a client should read as "poll". A `checkedWithin` gate is asked once per principal and root per pass, however many sockets share it.
  - oidc-rp: `verifySessionEnvelope` returns a session's user and its expiry.
  - vertical-auth: `AuthSubject.expiresAt` carries a session cookie's or a bearer's `exp`.
  - contracts: `LiveRefusal` gains `'forbidden'`.
  - ticket0: the portal's conversation view keeps itself current. A staff reply now shows up without a reload, pushed over `GET /api/conversations/:id/live` where the desk can push, and polled every 10s where it cannot. A live socket now closes when the session that opened it ends, and signing out ends every feed the page holds.

### Patch Changes

- Updated dependencies [35dc72e]
- Updated dependencies [32df62b]
- Updated dependencies [6154fd9]
- Updated dependencies [6d49012]
- Updated dependencies [55e6241]
- Updated dependencies [13a2067]
- Updated dependencies [7b15101]
- Updated dependencies [72f8e92]
- Updated dependencies [100b47c]
- Updated dependencies [d42bb2b]
- Updated dependencies [e5bd928]
- Updated dependencies [b180d3e]
- Updated dependencies [07388df]
- Updated dependencies [ae80b0d]
- Updated dependencies [a1f40e5]
- Updated dependencies [0e3d406]
- Updated dependencies [fed1f3c]
- Updated dependencies [5405401]
- Updated dependencies [655141a]
- Updated dependencies [f1290ea]
- Updated dependencies [ced5130]
  - @substrat-run/kernel@0.140.0
  - @substrat-run/contracts@0.140.0
  - @substrat-run/oidc-rp@0.11.0

## 0.20.0

### Minor Changes

- 48bf765: An installed vertical's members can be managed from the dashboard (#1150): listed, invited, moved between roles and removed. Every change is bounded by what the signed-in person holds in the vertical's own scope (§5.1, K-21), asked in the scope task that writes it.

  - Three scope-host verbs on both adapters, held by the permission contract suite: `listScopeRoleHolders(tenant, scope)` returns the live scope-level role assignments. `changeScopeRoleBounded(tenant, scope, caller, principal, from, to)` checks the caller's bound over both roles, then tombstones `from` and grants `to` in one transaction, or writes nothing. `revokeScopeRolesBounded(tenant, scope, caller, principal)` takes every scope role the principal holds, bounded over each, in one transaction. A role the tenant no longer defines confers nothing and is taken without a bound.
  - vertical-host's `mountPlatformSurface` takes an optional `members` hook and serves `GET /internal/members`, `POST /internal/members/invite`, `…/role` and `…/remove`. Without the hook all four answer `501`. The owner of record answers `409` (move it with the owner hand-over), and so does a principal holding a role outside the hook's `roles`, and a role move for someone whose invite is still open (withdraw it and invite again at the new role). A removal takes every scope role first, bounded by what the principal holds, then withdraws the open invite, then unbinds every login, so an accept of the old link afterwards finds nothing. The roster's open invites carry the roles their principal holds now beside the role they were minted at.
  - vertical-auth's `mountInviteRoutes` takes `revokeScopeRolesBounded` in place of `canAssign`: withdrawing an invite is bounded by the roles its principal holds now, asked in the scope task that takes them back, never by the role the invite row recorded at minting, and the grant goes with the row. A vertical passing `canAssign` passes `revokeScopeRolesBounded: (env, node, caller, principal) => host.revokeScopeRolesBounded(node.tenantId, node.scopeId, caller, principal)` instead.
  - vertical-auth's `membersHook({ roles, directory })` builds that hook. `mintMemberInvite` is now the one copy of what an invite is, run by both `mountInviteRoutes` and the platform route. The invite table's rows are plain functions in `@substrat-run/vertical-auth/member-directory`, which the IdentityDO delegates to, and `IdentityDO.listMemberBindings(scope)` gives the identity half of the roster.
  - control-plane-api serves `/tenants/:t/scopes/:s/members` (`GET` and `POST`), `…/members/:principal/role` and `…/members/:principal/remove`, pinned to the tenant. A change is made as the person the tenant credential was minted for (`onBehalfOf`). A credential naming nobody is refused `403`. Each change leaves `manageScopeMember` admin rows, the intent and then the outcome (`HostAdmin.recordMemberChange`).

### Patch Changes

- Updated dependencies [d62f6fb]
- Updated dependencies [98492af]
- Updated dependencies [2a505df]
- Updated dependencies [ec25a00]
- Updated dependencies [4a14c92]
- Updated dependencies [d55b4cd]
- Updated dependencies [48bf765]
  - @substrat-run/kernel@0.139.0
  - @substrat-run/contracts@0.139.0

## 0.19.1

### Patch Changes

- Updated dependencies [d5739ca]
- Updated dependencies [50ce5e0]
- Updated dependencies [59972cb]
- Updated dependencies [6476e71]
- Updated dependencies [d08b9b1]
- Updated dependencies [f33b1c3]
- Updated dependencies [bc6cc57]
- Updated dependencies [921dfa3]
  - @substrat-run/kernel@0.138.0
  - @substrat-run/contracts@0.138.0

## 0.19.0

### Minor Changes

- 7adf5c7: Owner claim links are `become` capabilities (#1686).

  The claim link the dashboard's Owner seat card hands an installer used to be a token whose hash the identity directory kept in a table of its own. It is now a `become` capability in the scope's own Durable Object: it expires after `OWNER_CLAIM_TTL_MS` (15 minutes), works once (`maxUses: 1`), can be revoked, and its use is recorded on the scope's spine as `capability.exercised`. What a claim link does for the installer is unchanged: the 15-minute first-sign-in window, "a new mint retires the old link", and one refusal for every failure.

  - `mintOwnerClaimLink` takes the identity directory and the scope host, the scope's `{ tenantId, scopeId }`, the origin, and optionally the platform actor that asked: `mintOwnerClaimLink({ directory: identityDo(env, ref), host: hostFor(env) }, ref, input.origin, input.actor)`. It mints the capability, records it in the directory as the current link, and revokes the previous one.
  - `mountOwnerClaim` (new subpath `@substrat-run/vertical-auth/owner-claim-routes`) is the redemption, `POST /api/claim-owner`, so a vertical no longer writes its own. It refuses a signed-out caller before reading anything, checks that the secret is the current link before exchanging it (so a stale or unrelated secret is refused without spending its use), exchanges it, and binds the signed-in subject. `noun` and `onClaimed` cover the parts a vertical owns.
  - `IdentityDO` gains `ownerClaimTarget`, `recordOwnerClaim`, `ownerClaimMatches` and `claimOwnerByCapability`, and loses `mintOwnerClaim`. `claimOwner` stays, redeem-only, for links minted before this release: those still work until they expire, at most 15 minutes after the deploy, and a new mint deletes them. It is removed in the next release.
  - `CloudflareScopeHost.mintCapabilityLocal` and `revokeCapabilityLocal` are the platform's `become` mint and revoke for the deployment that serves a scope. They are host methods, not module verbs: module code mints through `ctx.capabilities`, which mints `act` capabilities only.
  - `plausibleCapabilitySecret` (kernel) is the exchange's own first check on a secret, exported for the redemption route.
  - `/internal/owner-claim` accepts an optional `actor`, which the control plane now sends and the `mintOwnerClaim` hook receives as `input.actor`, so the capability records who asked.

  Re-push a vertical to move its claim links onto capabilities. Until then it keeps minting the old way.

### Patch Changes

- Updated dependencies [b2f8c86]
- Updated dependencies [7559e1a]
- Updated dependencies [21055d5]
- Updated dependencies [b641075]
- Updated dependencies [7adf5c7]
- Updated dependencies [1c411fc]
- Updated dependencies [fcb587d]
  - @substrat-run/oidc-rp@0.10.0
  - @substrat-run/contracts@0.137.0
  - @substrat-run/kernel@0.137.0

## 0.18.5

### Patch Changes

- Updated dependencies [1af2d47]
- Updated dependencies [fb1f624]
- Updated dependencies [4fdad69]
- Updated dependencies [4964eb8]
- Updated dependencies [30c2cda]
- Updated dependencies [b9b3b82]
- Updated dependencies [3ed9e9d]
- Updated dependencies [cdf32ab]
- Updated dependencies [7a28aea]
- Updated dependencies [7418e7e]
- Updated dependencies [18069f9]
  - @substrat-run/kernel@0.136.0
  - @substrat-run/contracts@0.136.0

## 0.18.4

### Patch Changes

- Updated dependencies [8267b83]
- Updated dependencies [1dca2da]
- Updated dependencies [3328549]
- Updated dependencies [8c64633]
- Updated dependencies [5d41454]
  - @substrat-run/kernel@0.135.0
  - @substrat-run/contracts@0.135.0

## 0.18.3

### Patch Changes

- Updated dependencies [176fe60]
- Updated dependencies [4347933]
- Updated dependencies [4347933]
- Updated dependencies [1addd27]
- Updated dependencies [560eec4]
  - @substrat-run/kernel@0.134.0
  - @substrat-run/contracts@0.134.0

## 0.18.2

### Patch Changes

- Updated dependencies [8a32578]
- Updated dependencies [c74c091]
- Updated dependencies [a08c42e]
- Updated dependencies [a128e65]
  - @substrat-run/kernel@0.133.0
  - @substrat-run/contracts@0.133.0

## 0.18.1

### Patch Changes

- 00050ce: Keep session cookies host-only on every configured platform base domain, even when a delivered cookie domain requests a parent shared by other tenants. Expire old domain cookies and invalidate sessions issued under the old policy.
- Updated dependencies [a2f02b1]
  - @substrat-run/kernel@0.132.1
  - @substrat-run/contracts@0.132.1

## 0.18.0

### Minor Changes

- 1250ecd: The identity directory adds `unbindPrincipal(scopeId, principal)`, which removes all subject bindings for a principal in one scope and returns the removed subjects. Member removal can now avoid a capped scope-wide scan that might miss a second login. The directory indexes scope and principal for this operation; callers can use the returned subjects to report each absent place to their identity issuer.

### Patch Changes

- @substrat-run/contracts@0.132.0
- @substrat-run/kernel@0.132.0

## 0.17.0

### Minor Changes

- 56091f8: The member invite routes now apply the role-assignment bound (#1931). An admin can create an invite only at a role whose permissions they already hold at the scope, and revoke one only on the same terms, judged by the role the stored invite confers. A refusal is a 403 naming the missing permissions, and nothing is granted, recorded or removed. The admin gate still runs first, before the body is read, so a caller it refuses gets the same answer as before whatever they sent.

  This needs three changes from a vertical that mounts `mountInviteRoutes`. Its `requireAdmin` returns the `{ principal }` it admitted. It passes `canAssign` for revoke and `assignScopeRoleBounded` for create, both wired to the host with the request's tenant and scope. A mount missing either dep, or with a gate that names no caller, refuses both routes instead of running them unbounded.

  The host read, `host.canAssign(tenantId, scopeId, principal, roleKey)`, gives the answer `ctx.canAssign` gives that principal inside an operation, from the same projected role and the same comparison, so an entity-narrowed grant does not satisfy it. The new `host.assignScopeRoleBounded(tenantId, scopeId, caller, assignee, roleKey)` checks that bound and writes the scope grant in one serialized scope task. A refusal returns the missing permissions and writes no role tuple. Both adapters implement these methods, and the permission contract suite checks their answers and grant effects. The identity directory gains `getInvite`, which reads one open invite by its principal.

  An invite whose role the tenant no longer defines can still be revoked. That role confers nothing, and the route lets through exactly the host's "no such role" refusal for that role; any other error still refuses. The kernel exports that refusal as `unknownRoleError` / `isUnknownRoleError`. On a host without a control plane, `host.canAssign` checks the scope was provisioned for the tenant it is asked under, and refuses as an unknown scope otherwise.

  `ScopeHost.canAssign` and `ScopeHost.assignScopeRoleBounded` are new required members of the `ScopeHost` interface, so a host implemented outside these two adapters must add them.

### Patch Changes

- Updated dependencies [012b2c8]
- Updated dependencies [56091f8]
- Updated dependencies [e5c21fc]
  - @substrat-run/contracts@0.131.0
  - @substrat-run/kernel@0.131.0

## 0.16.2

### Patch Changes

- Updated dependencies [65a0690]
- Updated dependencies [b53ecff]
- Updated dependencies [8236531]
  - @substrat-run/kernel@0.130.0
  - @substrat-run/contracts@0.130.0

## 0.16.1

### Patch Changes

- Updated dependencies [b213bfc]
  - @substrat-run/contracts@0.129.0
  - @substrat-run/kernel@0.129.0

## 0.16.0

### Minor Changes

- 4ba2a52: An owner hand-over. Platform staff can now move an instance's owner seat to another member with `POST /tenants/:tenantId/scopes/:scopeId/owner-transfer`. The vertical moves its owner of record, seats the new owner, then revokes the old one. Before this, the owner of record never moved, so if the successor was later revoked and the scope locked out, the lockout repair re-seated the original owner. It now re-seats whoever the record names. The new owner must already be a member who holds a role in the instance, and a second hand-over is refused while one is unfinished; resending the unfinished one completes it, and a repeat after that changes nothing. One that can no longer finish, because the new owner was removed after it started, is refused on every resend; staff close it with `abandon: true`, which seats and revokes nothing. A re-provision now seats the owner of record rather than the principal the platform minted at install. A vertical opts in with vertical-host's new `transferOwner`, `completeOwnerTransfer` and `abandonOwnerTransfer` hooks (vertical-auth's `IdentityDO` methods are the reference); without them the route answers `501`. Every attempt is on the admin log as `transferOwner` rows naming both principals.

### Patch Changes

- Updated dependencies [260fb5a]
- Updated dependencies [4a53af7]
- Updated dependencies [4ba2a52]
- Updated dependencies [f79e8ba]
- Updated dependencies [ba75c81]
  - @substrat-run/contracts@0.128.0
  - @substrat-run/kernel@0.128.0

## 0.15.9

### Patch Changes

- Updated dependencies [2f1e5f5]
- Updated dependencies [b6248b0]
  - @substrat-run/kernel@0.127.0
  - @substrat-run/contracts@0.127.0

## 0.15.8

### Patch Changes

- Updated dependencies [6d57761]
- Updated dependencies [c78e713]
- Updated dependencies [e1526a0]
  - @substrat-run/contracts@0.126.0
  - @substrat-run/kernel@0.126.0

## 0.15.7

### Patch Changes

- Updated dependencies [e8d4860]
- Updated dependencies [9ebacee]
  - @substrat-run/contracts@0.125.0
  - @substrat-run/kernel@0.125.0

## 0.15.6

### Patch Changes

- Updated dependencies [90d0f02]
- Updated dependencies [02942e0]
- Updated dependencies [931b8d6]
- Updated dependencies [558f103]
- Updated dependencies [45421e8]
  - @substrat-run/kernel@0.124.0
  - @substrat-run/contracts@0.124.0

## 0.15.5

### Patch Changes

- df0b2d0: `IdentityStub` now carries the site-registry methods (`recordSite`, `forgetSite`, `listSites`, `resolveSiteScope`) the `IdentityDO` class already had, so a worker calling them through the stub type-checks. A type-level pin fails the build if the class and the stub drift apart again.
- Updated dependencies [f56e9eb]
- Updated dependencies [6b3cb45]
- Updated dependencies [ae19d01]
- Updated dependencies [30b09c6]
- Updated dependencies [d423d10]
- Updated dependencies [bd8f408]
  - @substrat-run/contracts@0.123.0
  - @substrat-run/kernel@0.123.0

## 0.15.4

### Patch Changes

- c8554a1: The bearer path (`@substrat-run/vertical-auth/oidc`) now looks its signing keys up through `oidc-rp`'s bound discovery instead of a second, unchecked one: the document must name the configured issuer, a redirect off the issuer's origin is refused, and a failed lookup is retried rather than remembered for the isolate's life. A delivered `substrat:auth` with a plaintext (non-loopback `http`) issuer now answers 503 (`AuthConfigError`) instead of building a provider that would send its client secret in the clear. It does not fall back to the deployment's default identity provider, and the same refusal applies to the deployment default issuer and to an issuer that is not a plain identifier. On the settings path (`AUTH_PROVIDER=oidc`), a plaintext or query-carrying `OIDC_ISSUER` now answers 503 (`AuthConfigError`) instead of 401 on every request. `authorizationServersOf` names none of those issuers. A `jwksUri` override is held to the same transport rule as a discovered `jwks_uri`, and the issuer is checked when an override skips discovery.
- Updated dependencies [0803833]
- Updated dependencies [c8554a1]
- Updated dependencies [c074320]
- Updated dependencies [1e326dd]
- Updated dependencies [3a3338d]
  - @substrat-run/contracts@0.122.0
  - @substrat-run/kernel@0.122.0
  - @substrat-run/oidc-rp@0.9.1

## 0.15.3

### Patch Changes

- 5799e32: The places reporter now sends the install's client secret only to the issuer's own origin. The report endpoint an issuer's discovery document names must match the issuer's scheme, host and port exactly, must be `https` (`http` only on a loopback issuer, as the dev issuer is), and must carry no credentials. The report is sent with `redirect: 'manual'`, so a redirect is a failed report and is never followed. A refused endpoint sends nothing, is reported as `failed` like an unreachable issuer, and is logged once with its origin only. The issuer the real auth-server names is its own origin, so nothing deployed changes.
- Updated dependencies [a235648]
- Updated dependencies [6fc9950]
- Updated dependencies [48fea30]
- Updated dependencies [a6f4db1]
- Updated dependencies [45b927e]
  - @substrat-run/contracts@0.121.0
  - @substrat-run/kernel@0.121.0

## 0.15.2

### Patch Changes

- Updated dependencies [1de077d]
  - @substrat-run/kernel@0.120.0
  - @substrat-run/contracts@0.120.0

## 0.15.1

### Patch Changes

- Updated dependencies [bc6a6bb]
- Updated dependencies [bb10d6d]
- Updated dependencies [84b5fe2]
- Updated dependencies [929ec09]
- Updated dependencies [a9cfc4a]
- Updated dependencies [2c65b67]
- Updated dependencies [8009cd1]
- Updated dependencies [b080e0f]
- Updated dependencies [e7113ea]
  - @substrat-run/kernel@0.119.0
  - @substrat-run/contracts@0.119.0

## 0.15.0

### Minor Changes

- 030fafd: A vertical bound to a team auth server accepts only bearer tokens minted for it.

  Before, when no `audience` was configured, the relying party's bearer fallback checked only the token's signature and issuer. Every app on a team auth server shares that issuer, and so does any client that registers itself there. So on every route, a vertical accepted another app's `id_token` and an access token requested for another vertical's MCP endpoint. Cookie sessions were never affected.

  Now, when the delivered config marks the issuer as shared (`substrat:auth:shared-issuer` = `"true"`, exported as `SHARED_ISSUER_CONFIG_KEY` from `@substrat-run/contracts`), a bearer is accepted only if it is the app's own:

  - its `aud` names the app's MCP resource on the origin the request reached (`mcpResourceOf`). That is an MCP client's access token, whatever client requested it.
  - its `azp` / `client_id` is the app's client id. Every one that is present must match.
  - it has neither claim, and its `aud` is exactly the app's client id. That is the app's own `id_token`. A multi-valued `aud` with no `azp` is refused.

  Anything else is a `401`. A configured `audience` still wins, as before. `oidcRpAuthProvider` takes the marker as `sharedIssuer`, and `instanceAuthFor` reads it from the delivered config. `AuthProvider.resolve` takes an optional second argument, the request URL. A caller that omits it (every existing one) gets the origin from the `Host` header.

  **Issuers you configured by hand are unchanged.** Supabase, Auth0, Keycloak and the like carry no marker, and their bearers are checked exactly as before. To hold them to one audience, set the connection's `audience` (`authenticated` for a Supabase access token, the API identifier at Auth0).

  The dashboard delivers the marker beside `substrat:auth` at install and on an Identity change. The issuer decides whether it is shared, not the part of the form it was picked from, so a hand-typed issuer URL that is one of the team's auth servers is marked too. The same classification runs at install, on an Identity change and in the heal. Apps installed before this get it the next time anyone on the team opens the Apps list, from the same pass that registers their MCP endpoint. That pass retries on later loads until the marker lands. It also retries while one of the team's auth servers cannot be located, so apps bound to it are never mistaken for apps on an outside issuer. Every delivery it could not make is logged, marker failures included. On a team with no auth server left, it clears the marker from every app that still carries it. An existing install is protected once both halves are live: this dashboard, and a deploy of the vertical built against this `vertical-auth`.

  The dev issuer's `/dev/token` now mints for `substrat-dev` by default, the client `devLogin` signs in as (it was `dev`), and `devLogin` applies the team rule, so a script that works locally works hosted. A script that passed `audience: 'dev'` explicitly, or that points `devLogin` at another client id with `OIDC_CLIENT_ID`, must now mint for that client id. `DEV_CLIENT_ID` is exported.

- 429cc84: A vertical can tell its identity pool who is a member, so a login's "Your places" list at a team auth server stays in step with the app.

  `@substrat-run/vertical-auth` adds `placesReporter`, built from an instance's delivered identity, and three calls on top of it:

  - `observePlace` reports what a resolve just established. Call it after `/api/me` resolves a signed-in subject: bound means present, unbound means absent. It goes once per login per isolate, and again after an hour.
  - `unbindMember` removes a member's binding and reports the place gone.
  - `reportScopeMembers` sends the whole set bound in a scope. Run it from your provision hook, which the platform's reconcile re-runs, and a report that went missing is repaired. A scope with more than 10,000 bindings is refused and logged rather than half-sent.

  Reports are best-effort and never throw. They go only to an issuer that publishes `/.well-known/substrat-places`, so an external issuer (Supabase, Auth0, …) is never sent one.

  `IdentityDO` gains `unbind(scopeId, sub)` and `subjectsOf(scopeId, limit)`. `unbind` is the directory's first removal: it takes the binding away and never re-opens the owner seat.

  `@substrat-run/contracts` exports the shared vocabulary:

  - `place`, the exact entry: tenant, scope, hostname, name.
  - `placeRegistration` / `placeRegistrations` and `PLACES_CONFIG_PREFIX`, which is how the platform registers a team's apps at an issuer.
  - `placeReport` and `MAX_PLACE_MEMBERS`, what a vertical sends.
  - `PLACES_DISCOVERY_PATH` / `placesDiscovery`.

### Patch Changes

- Updated dependencies [030fafd]
- Updated dependencies [56a931b]
- Updated dependencies [429cc84]
  - @substrat-run/contracts@0.118.0
  - @substrat-run/kernel@0.118.0

## 0.14.6

### Patch Changes

- Updated dependencies [6504a99]
- Updated dependencies [aabc227]
- Updated dependencies [fb37a3e]
- Updated dependencies [44299a1]
- Updated dependencies [4ef164c]
- Updated dependencies [d7eb089]
- Updated dependencies [269fa7a]
- Updated dependencies [105a4c3]
- Updated dependencies [a8c2c64]
- Updated dependencies [02c181a]
- Updated dependencies [2fa5147]
- Updated dependencies [1f223f5]
  - @substrat-run/contracts@0.117.0
  - @substrat-run/kernel@0.117.0

## 0.14.5

### Patch Changes

- Updated dependencies [e22db55]
- Updated dependencies [a67c59b]
- Updated dependencies [45d2f15]
- Updated dependencies [e99332e]
- Updated dependencies [1c55458]
- Updated dependencies [0b993ff]
  - @substrat-run/contracts@0.116.0
  - @substrat-run/kernel@0.116.0

## 0.14.4

### Patch Changes

- Updated dependencies [1a6fe4d]
  - @substrat-run/contracts@0.115.0
  - @substrat-run/kernel@0.115.0

## 0.14.3

### Patch Changes

- Updated dependencies [f58aa74]
  - @substrat-run/contracts@0.114.0
  - @substrat-run/kernel@0.114.0

## 0.14.2

### Patch Changes

- Updated dependencies [c146761]
- Updated dependencies [c3c92e9]
- Updated dependencies [2fc7187]
- Updated dependencies [7e6f925]
  - @substrat-run/contracts@0.113.0
  - @substrat-run/kernel@0.113.0

## 0.14.1

### Patch Changes

- Updated dependencies [c697b15]
- Updated dependencies [db6a96f]
- Updated dependencies [221f94a]
- Updated dependencies [79308fb]
- Updated dependencies [f4d12b7]
  - @substrat-run/contracts@0.112.0
  - @substrat-run/kernel@0.112.0
  - @substrat-run/psl@0.2.5

## 0.14.0

### Minor Changes

- d40a1f7: `mountInviteRoutes(app, deps)` — the member-invite routes a vertical mounts (list, create, revoke, accept), written once instead of copied per worker. A vertical supplies its node resolver, its admin gate, its roles, its identity directory, the host's `assignScopeRole` and its auth provider; the token minting, the hash-only storage, the grant-before-record order and the status codes are the package's. `hono` becomes a peer dependency, as it is for `@substrat-run/dev-issuer`.

### Patch Changes

- Updated dependencies [f08bfc4]
- Updated dependencies [aaafae3]
- Updated dependencies [1b2506c]
  - @substrat-run/contracts@0.111.0
  - @substrat-run/kernel@0.111.0

## 0.13.2

### Patch Changes

- Updated dependencies [a195037]
- Updated dependencies [8758949]
- Updated dependencies [d05689d]
- Updated dependencies [0257dbd]
- Updated dependencies [cb88aa1]
  - @substrat-run/contracts@0.110.0

## 0.13.1

### Patch Changes

- c22e0f3: A hosted vertical's federated sign-out stops at a "Confirm logout" page no longer.

  `oidcRpAuthProvider` — the provider every hosted vertical composes — threw away the ID
  token the login round-trip verified, so the only RP-initiated logout it could ask for was
  an anonymous one. Without `id_token_hint` an issuer cannot tell a real sign-out from a
  link somebody was tricked into following, so OIDC RP-Initiated Logout §2 says it SHOULD
  ask the person to confirm, and Better Auth's provider does: an interstitial in the middle
  of what the person already asked for.

  The provider now keeps that token in its own cookie — scoped to the logout path,
  `SameSite=Strict`, the same lifetime as the session — and `GET /api/auth/logout?federated`
  hands it back to the issuer, which verifies the request against the session the hint names
  and redirects straight through. This is what `mountOidcRoutes` already did for the platform
  apps; the two now share one implementation of the rule, `federatedLogoutUrl` in
  `@substrat-run/oidc-rp`, rather than a copy each.

  Discovery no longer caches a failure. It is cached per issuer for the life of an isolate,
  and a rejection stayed there too — so one lookup against an issuer that happened to be
  down took every later login in that isolate with it, after the issuer had recovered.
  Federated logout is what made that reachable: it degrades to a local sign-out, so the
  request that poisoned the cache is the one that looked like it worked.

  Unchanged: a plain `/api/auth/logout` stays local, and the local sign-out still happens
  first, so an issuer that is down or advertises no end-session endpoint can only leave its
  own session standing. A session minted before this version has no hint and still sees the
  confirmation page — the next sign-in puts one there.

- Updated dependencies [7aa3ea5]
- Updated dependencies [1e175ce]
- Updated dependencies [c22e0f3]
  - @substrat-run/contracts@0.109.0
  - @substrat-run/oidc-rp@0.9.0

## 0.13.0

### Minor Changes

- aab2e11: Carry the issuer's `email_verified` claim through to the session and the auth subject.

  An address only says who someone is if the issuer stands behind it, and until now nothing
  transported that answer: the claim was read nowhere, so a gate on it could not be written.
  `SessionUser.emailVerified` and `AuthSubject.emailVerified` now hold what the issuer said —
  `true`, `false`, or `undefined` when it said nothing, which is a different fact from
  "unverified" and stays distinguishable end to end. The flag travels with the address it
  qualifies, so a UserInfo response never vouches for an address the ID token signed.

  Nothing authorizes differently: this is transport, and every existing session keeps working
  with the field absent.

### Patch Changes

- Updated dependencies [aab2e11]
- Updated dependencies [0a8a3b0]
- Updated dependencies [5cf7ae4]
- Updated dependencies [44b53e4]
  - @substrat-run/oidc-rp@0.8.0
  - @substrat-run/contracts@0.108.0

## 0.12.10

### Patch Changes

- Updated dependencies [4a6c4c3]
- Updated dependencies [2ffed76]
  - @substrat-run/contracts@0.107.0
  - @substrat-run/oidc-rp@0.7.0

## 0.12.9

### Patch Changes

- @substrat-run/contracts@0.106.0

## 0.12.8

### Patch Changes

- @substrat-run/contracts@0.105.0

## 0.12.7

### Patch Changes

- Updated dependencies [dd999a9]
  - @substrat-run/contracts@0.104.0

## 0.12.6

### Patch Changes

- Updated dependencies [dc9995c]
- Updated dependencies [adf6bfb]
  - @substrat-run/contracts@0.103.0

## 0.12.5

### Patch Changes

- Updated dependencies [e7115b2]
- Updated dependencies [3e67ebe]
  - @substrat-run/contracts@0.102.0

## 0.12.4

### Patch Changes

- Updated dependencies [b61c4d5]
- Updated dependencies [306b893]
  - @substrat-run/contracts@0.101.0

## 0.12.3

### Patch Changes

- Updated dependencies [0cd3055]
- Updated dependencies [4b159da]
- Updated dependencies [d1a5a58]
- Updated dependencies [8912fb8]
- Updated dependencies [6b3e466]
  - @substrat-run/contracts@0.100.0

## 0.12.2

### Patch Changes

- Updated dependencies [e398034]
- Updated dependencies [28a82c0]
- Updated dependencies [d124e9a]
- Updated dependencies [8e29866]
- Updated dependencies [02793d9]
  - @substrat-run/contracts@0.99.0

## 0.12.1

### Patch Changes

- Updated dependencies [05de166]
- Updated dependencies [07203fb]
  - @substrat-run/contracts@0.98.0

## 0.12.0

### Minor Changes

- 9fcfebc: A vertical now serves an MCP endpoint, and writes nothing to get it. `mountOperations` renders the operations it is already mounting a third way — REST, OpenAPI, and now one MCP tool per operation at `${basePath}/mcp` — dispatching through the same `resolveStub` and the same permission checks. `http` is the declaration: an operation that faces the network is a tool, one that does not is not, and there is no `mcp: true` to restate a fact the route already carries. Descriptions come from `summary`, input schemas from the declared Zod object, and read-only/destructive hints from the method.

  It defaults on because it adds no reachability: every tool is a route that already existed, behind the same bearer verification and the same `assertAllowed(ctx.check(…))`. What that buys is a split a hand-rolled server usually gets wrong — authentication stays transport-level, so an anonymous call is an HTTP 401 that starts a client's authorization flow, while authorization is in-band, so a refused permission is a readable tool error the agent can work around rather than a broken session. A paged read's tool schema names `limit`/`cursor`/`order`/`sort` explicitly, since an MCP call has no query string to carry them and a list that looks unpaged is read as a whole table.

  The one knob is optional and per operation: `mcp: false` keeps a machine-facing route — a connector's return path, a relay's ingest, a widget service's surface — out of the tool list, and `mcp: { description }` says more than an API-document summary where tool selection needs it. A new vertical writes neither. `mountOperations(…, { mcp: false })` turns the endpoint off entirely.

  The endpoint also publishes RFC 9728 protected-resource metadata, so a client that gets a 401 can find out where to authenticate instead of being handed a token by hand: the challenge names a `.well-known/oauth-protected-resource` document, and the document names the issuer. That one fact cannot be derived — a hosted vertical's issuer is per-scope configuration, one serving script answering for many installs — so it is the single line of wiring, resolved per request, and `authorizationServersOf` in `@substrat-run/vertical-auth` builds it from an instance's resolved config. Omit it and the endpoint still works with a bare `Bearer` challenge; a challenge is never pointed at a document that is not served. Client registration stays out: how a client gets a `client_id` is the authorization server's question, not a resource server's.

### Patch Changes

- Updated dependencies [9fcfebc]
  - @substrat-run/contracts@0.97.0

## 0.11.1

### Patch Changes

- Updated dependencies [db5a3da]
- Updated dependencies [a4704de]
  - @substrat-run/contracts@0.96.0
  - @substrat-run/oidc-rp@0.6.0

## 0.11.0

### Minor Changes

- 2b53117: A `/tokens` subpath export, so a node host can reach `sha256Hex`, `claimToken`,
  `ownerClaimPath` and the new `invitePath` without importing the package root — which
  exports `IdentityDO`, and `IdentityDO` imports `cloudflare:workers`. A vertical's dev
  server and its worker can now build the same invite link from the same three facts.

## 0.10.1

### Patch Changes

- Updated dependencies [f065a84]
- Updated dependencies [7bf77df]
  - @substrat-run/contracts@0.95.0

## 0.10.0

### Minor Changes

- 225bb69: New `instanceAuthFor` — the composition four verticals were each writing for themselves:
  read an instance's delivered config in one DO hop, parse the `substrat:auth` choice,
  resolve the declared settings (delivered > binding > manifest default), and select the
  `AuthProvider`. Exported alongside `parseAuthChoice`, `selectAuthProvider`,
  `AUTH_CONFIG_KEY` and `AuthConfigError` (which carries the status an unconfigured instance
  should answer with). Purely additive — the primitives it composes are unchanged.

### Patch Changes

- Updated dependencies [692cb92]
- Updated dependencies [c9f3bac]
- Updated dependencies [e6dbb7b]
- Updated dependencies [568ba88]
- Updated dependencies [733469b]
- Updated dependencies [35147a9]
  - @substrat-run/contracts@0.94.0
  - @substrat-run/psl@0.2.4

## 0.9.0

### Minor Changes

- 75bd27c: The owner seat is claimed by whoever signs in first — for fifteen minutes, and then by a claim link (#925)

  A hosted vertical's owner seat is minted empty at provision and bound to a human by the first
  verified subject to arrive. That is the right trade in the install flow, where the installer
  opens the app seconds later. It was the wrong trade everywhere else: the window was unbounded
  in time and in audience, so a CI-deployed instance whose issuer had open sign-up sat as a seat
  anyone could take, indefinitely — and nothing anywhere said it was open. A re-provision made
  it worse: `INSERT OR REPLACE` re-minted the pending seat on every reconcile, so a sweep could
  hand a claimed desk's ownership to the next stranger to sign in.

  **`@substrat-run/vertical-auth`** — the rules now live in `owner-seat.ts`, unit-tested over a
  real SQLite. The first-sign-in claim closes `FIRST_SIGN_IN_WINDOW_MS` (15 min) after provision;
  a seat from before the column existed reads as closed. The seat then stays pending — `needsSetup`
  keeps saying so, and the new `ownerSeat` says _why_ — until a claim binds it. `mintOwnerClaim` /
  `claimOwner` are the claim link (only the token's hash is stored; minting again retires the
  earlier link), and `mintOwnerClaimLink` does token + hash + URL in one call. A re-provision
  keeps the window it has and never re-opens a claimed seat.

  **`@substrat-run/vertical-host`** — two flavored routes, `GET /internal/owner-seat` and
  `POST /internal/owner-claim`, over the `ownerSeat` / `mintOwnerClaim` hooks (501 without them),
  parsed on the way out as well as in. **`@substrat-run/contracts`** — the `ownerSeat` and
  `ownerClaimLink` shapes. **`@substrat-run/control-plane-api`** — `GET …/owner-seat` and
  `POST …/owner-claim` per scope, with the link's origin taken from the platform's own hostname
  directory (canonical `app` first), never from a body.

  **Dashboard** — an _Owner seat_ card on the app's Overview: claimed, unclaimed with the window
  still open (pulsing — open it now), or unclaimed and closed, with a _Get claim link_ button.
  The link is shown once and stored nowhere.

  **The four verticals on vertical-auth** (callout, meridian, manyfold, ticket0) — `/api/me`'s
  `needs-setup` answer now carries `firstSignInOpen`, the SPAs say which way in applies instead
  of offering a sign-in that binds nobody, and `?claim=<token>` → `POST /api/claim-owner` is the
  counterpart of the invite flow.

  Not built: binding from the projected identity links (#406). The dashboard links identities
  under the platform's own pool, and a hosted app's issuer is always an external one or a team
  Auth Server — so no link would ever match, and matching on `sub` alone would be the cross-pool
  bind the issue warns against.

## 0.8.1

### Patch Changes

- 7cce6cd: auth-server: migrate to `@better-auth/oauth-provider`, and bump the fleet to Better Auth 1.7

  Better Auth 1.7 **removes** the in-core `oidcProvider` plugin (deprecated since 1.6). Our range
  was already `^1.6.23`, which permits 1.7 — so this was not a migration we could schedule, only
  one we could be surprised by: any dependency refresh would have taken the plugin away and left
  `demos/auth-server` unable to compile.

  The fleet bump is free. Only `admin`, `jwt` and `oidcProvider` are used anywhere in the
  workspace, and only auth-server uses the last two; vertical-auth, control-plane-api, rally,
  handlebar and shop are on email/password + `admin`, and pass unchanged on 1.7.1 (147 tests).

  **The schema is now generated, because hand-keeping it stopped being plausible.** Three tables
  became seven, with forty-odd columns. `db/ddl.generated.ts` and `src/auth-schema.generated.ts`
  are emitted by `scripts/gen-schema.mts` from `getAuthTables(auth.options)` — read off the real
  `buildAuth` config, not a parallel one — and `test/schema-generated.test.ts` re-emits, compares,
  and then **executes the DDL against a real database** and drives the adapter through it. That
  last part is not ceremony: 1.7 adds a required `issuer` column to `account`, a table that
  already existed, and a diff of hand-written DDL would not have flagged it while every password
  sign-in on an upgraded install would have failed.

  **Upgrading an existing store is not `IF NOT EXISTS`.** `db/upgrade.ts` runs before the DDL on
  every boot and handles the two places that construct is silently wrong: `account.issuer` is
  added and backfilled with `local:<provider_id>` (user credentials — carried, never dropped),
  and `oauth_access_token` / `oauth_consent`, whose NAMES 1.7 reuses with different columns, are
  renamed to `legacy_*` so the new DDL creates the new shape instead of leaving the old one in
  place for the plugin to query columns off. Renamed rather than dropped: a clean break is about
  not carrying the old registry forward, not about an unattended `DROP` on a live issuer. Per the
  decision on this change, **relying parties must be re-registered** after an upgrade; what was
  there stays readable under `legacy_oauth_application`.

  **What changed on the wire** — each of these would strand a relying party silently, so each is
  pinned in `test/oidc-flow.test.ts`:

  - **PKCE is mandatory**, confidential clients included. No `code_challenge` ⇒ `invalid_request`
    at the callback. Every RP pointed at this issuer needs it.
  - **The pending authorize request is no longer server-side state.** It travels as the entire
    signed query on the redirect to `/login` / `/signup` / `/consent`, and the page hands it back
    as `oauth_query`. A sign-in that omits it succeeds and resumes _nothing_ — #898's symptom
    through a new mechanism, so the suite asserts the omission fails as well as the inclusion
    working.
  - **Consent** takes `{ accept, oauth_query }` and answers Better Auth's redirect envelope
    (`{ redirect, url }`), not `consent_code` / `redirectURI`. The signed query is also what
    makes tampering detectable, since the request now travels through the browser.
  - **`client_secret_basic` is the default** auth method; the plugin refuses a body-posted secret
    from such a client. Carried-over integrations must register
    `token_endpoint_auth_method: 'client_secret_post'` or move the secret to the header.
  - **Discovery moved to the root** — the plugin serves `/.well-known/openid-configuration`
    itself, so `routes.ts`'s alias onto `/api/auth/…` is deleted rather than kept.
  - **The issuer identity is pinned to the clean origin** via `jwt({ jwt: { issuer } })`. Left
    alone, `oauthProvider` derives it from `baseURL`, which includes `/api/auth`, while every RP
    is configured with `OIDC_ISSUER = {origin}` and fetches discovery from the root. OIDC requires
    those to match; strict clients reject the id_token otherwise. Callbacks now also carry `iss`
    (RFC 9207).

  **The client registry yesterday's work hand-wrote is deleted, and what replaced it is split.**
  `src/clients.ts` (id minting, secret rotation, comma-joined redirect URIs) is gone: the plugin
  ships create/rotate, and `clientPrivileges` in `src/auth.ts` admits only the `admin` role —
  while leaving unauthenticated RFC 7591 registration open, because it consults the hook only
  when a session is present. What stayed ours is what the plugin models differently: it treats a
  client as something a USER owns (`client.userId === session.user.id` on every mutating
  endpoint, and no `disabled` field at all), so listing, editing, disabling and removing are
  ours, or an operator could never withdraw an application someone else registered. Registering
  proxies the plugin's `SERVER_ONLY` admin endpoint — that variant can set `skip_consent`, which
  is a column now instead of a `trustedClients` entry in source, which is why the dashboard can
  offer it.

  **The demo relying party no longer ships a password.** `trustedClients` is gone as an option,
  and secrets are hashed at rest, so `substrat-demo-rp` / `demo-rp-secret-not-for-production` —
  resolved by every deployment, production included — is replaced by a per-boot registration
  whose minted credentials the dev server prints.

  Driven in a browser end to end, not only in vitest: registering a client through the dashboard,
  its secret shown once, then an authorize request landing a signed-out visitor on `/login`,
  signing in there, resuming to `/consent`, approving, and arriving at the relying party's
  callback with `code`, `state` and `iss`.

## 0.8.0

### Minor Changes

- ae4e894: `oidcRpAuthProvider` forwards `prompt` to the issuer

  `/api/auth/login?prompt=select_account` (and `prompt=login`) now reaches the authorize
  endpoint, as it already did through `mountOidcRoutes`. Without it a vertical had no way to
  offer "sign in as someone else": an issuer holding a live SSO session silently
  re-authenticates the same user, so the button appears to do nothing. Allowlisted to the two
  IdP-recognised values; absent `prompt` behaves exactly as before.

## 0.7.1

### Patch Changes

- 87ec6f2: Every published package now actually ships its license text.

  `LICENSING.md` has always opened by claiming each package "ships the full text in its
  tarball." Eight of them did not: `adapter-cloudflare`, `control-plane-api`,
  `vertical-auth`, `oidc-rp`, `psl`, `boundary-lint`, `model-emit` and `create-substrat`
  declared a license in `package.json` and shipped no `LICENSE` file. npm auto-includes
  `LICENSE*` when present — none was present, so nothing was included.

  That is worth a version bump rather than a docs fix, because a tarball is where the
  claim is either true or false, and `adapter-cloudflare` is the load-bearing case: §5.7
  makes the Cloudflare adapter half of the two-adapter rule that keeps the escrow story
  literally true, and AGPL is what stops a hosted derivative of it from staying closed.
  An AGPL package distributed without its license text is the weakest possible version of
  that. The texts are the stock unmodified AGPL-3.0 and Apache-2.0, byte-identical to the
  copies already in `kernel` and `contracts`.

  No code changes.

- Updated dependencies [87ec6f2]
  - @substrat-run/oidc-rp@0.5.1
  - @substrat-run/psl@0.2.2

## 0.7.0

### Minor Changes

- 6ac51d1: feat: verticals built outside this repo can install the auth the starter tells them to use

  `create-substrat` scaffolds a vertical whose `/api/*` routes are 401 until real auth is wired
  into `authenticatedPrincipal`, and the template comment points the reader at
  `@substrat-run/vertical-auth` "for the intended shape". That package was `private: true` and
  absent from npm, so the pointer went nowhere: every out-of-repo vertical either hand-rolled the
  owner-claim, `sub`→principal and invite-only logic the `IdentityDO` exists to get right, or
  copied the source. Both packages are now published.

  - **`@substrat-run/vertical-auth` is published**, and ships compiled output like every other
    package here rather than raw `src`. `exports` (root plus the `./provider`, `./oidc` and
    `./oidc-rp-provider` subpaths) resolve to `dist` with declarations; `files` is `["dist"]`.
    The build follows the repo convention — `tsc -p tsconfig.json` for `src`, with the tests
    kept under their own `tsconfig.test.json` so `typecheck` still covers them.
  - **`@substrat-run/oidc-rp` is published** as its dependency. Inlining it into `vertical-auth`
    was the alternative and was rejected: the same Authorization-Code + PKCE round-trip and
    session mint/verify authenticate staff, builders and the CLI in the control plane, and
    security-critical code that has to be fixed twice is worse than one more public package.
    Its description no longer claims the platform apps are the only consumers.

  No behaviour changes — this is packaging. In-repo consumers (Callout, Meridian, Manyfold)
  import from the package root and are unaffected beyond resolving `dist` instead of `src`.

### Patch Changes

- Updated dependencies [6ac51d1]
- Updated dependencies [6ac51d1]
  - @substrat-run/psl@0.2.1
  - @substrat-run/oidc-rp@0.5.0

## 0.6.0

### Minor Changes

- b20cd82: `IdentityDO.getScopeConfig(scopeId)` — the blessed read for a hosted vertical's ordinary
  env-spec keys (#398): the per-scope config map the platform delivered via
  `/internal/configure`, ready to hand to `resolveScopedEnvSpec` (contracts) so an Env-tab
  override actually takes effect instead of the shared deployment default (the #374
  silent-defaults trap). `authWiring()` now reads through it; its shape is unchanged.

## 0.5.0

### Minor Changes

- fbf0704: Multi-scope Manyfold: archive a site.

  Rounds out scope management (create + switch were already there) with **archive**, reusing the
  platform-intent mechanism — archiving a scope is a platform action the sandbox-clean vertical can't
  do itself, so it's another intent kind:

  - **contracts:** `archive-scope` kind + `archiveScopePayload` (`{ scopeId }`).
  - **control-plane-api:** `archiveScopeHandler` — the drained scope proves the tenant; the target
    must be under that same tenant and run the same vertical (verified against the directory), then
    `host.admin.archiveScope`. Idempotent (an already-archived/absent target is a no-op success).
  - **control-plane worker:** registers `archive-scope` alongside `provision-sibling` in the drain.
  - **vertical-auth:** `IdentityDO.forgetSite` drops a site from the per-tenant registry.
  - **Manyfold:** a `manyfold/archive-site` op (`content:manage-sites` — no new permission) enqueues
    the intent; `POST /api/sites/:slug/archive` runs it as the caller, then optimistically drops the
    site from the registry so the switcher updates immediately.
  - **Manyfold app:** an admin-only **Archive** control next to the switcher (shown only when the
    tenant has more than one site); it archives the current site and switches away.

  Tested: the handler archives its target + is idempotent + refuses a cross-vertical target;
  `forgetSite` drops a site; the `archive-site` op enqueues an `archive-scope` intent and an author is
  denied. Refs #358.

## 0.4.0

### Minor Changes

- ad4ccbf: Manyfold multi-scope, M2: a per-tenant site registry so the app lists and switches its sites.

  The per-tenant `IdentityDO` gains a site registry (`recordSite` / `listSites` /
  `resolveSiteScope`, logic factored into `site-registry.ts` so it is unit-testable without a
  Durable Object). Manyfold's worker records each site at `/internal/provision`, serves the
  tenant's sites at `GET /api/sites` (previously 404 in production, which left the switcher
  empty), and resolves the app's `x-site` slug selection to the corresponding scope in `nodeFor`
  — so the existing in-app site switcher now actually switches sites on a deployed install.
  `nodeFor` is split from a sync `baseNode` (the routed tenant + home scope, which the auth
  provider keys on) so the async site resolution never touches the auth path. Tenant isolation is
  unchanged: the registry is per-tenant and `getScope` re-checks the (tenant, scope) pair.

## 0.3.3

### Patch Changes

- c64bdf8: Builder-facing recovery for a scope stranded at "roles projected, zero tuples" (#332).

  A CP-less hosted scope could be left with its role definitions projected and
  `permission_source = 'local'` but no principal holding a role — so strict local
  enforcement evaluated against an empty tuple table, every login was denied, and the
  builder who owned the vertical had no lever to fix it (`/internal/provision` is gated by
  the platform's secret, which is correctly never theirs). This closes the hole with a
  prevention and a repair, and never hands a builder `PLATFORM_SECRET`.

  - **Provision is atomic now.** `applyProjection` gains an additive `scopeTuples` argument,
    and `provisionScopeLocal` writes the owner's role grant in the **same** enqueued unit as
    the enforcement flip rather than a follow-up `writeTuple` — so a drop between the two can
    no longer strand a scope. An empty-tuple **guard** refuses to switch on strict local
    enforcement when roles are projected but no live principal→role grant exists (across
    scope- and tenant-level tuples), backstopping every projection path.

  - **The vertical remembers its owner.** `@substrat-run/vertical-auth`'s IdentityDO adds a
    durable `owner_of_record` seat (set at provision, never consumed — unlike `pending_owner`,
    which the first login claims). It lives in the per-tenant IdentityDO, a different DO from
    the scope's data DO, so it survives a scope-DO storage wipe (e.g. a promote, #321).

  - **A builder can trigger the repair.** New `POST /tenants/:tenantId/scopes/:scopeId/provision`
    on the control-plane API — builder-reachable (allowlisted **and** ownership-checked: a
    builder may only reconcile a scope running a vertical its own tenant owns) — re-gathers the
    tenant's entitlements and delegates to the vertical's new `/internal/reconcile`, which
    re-sources the owner from `owner_of_record` and re-runs the idempotent provision. The CP
    holds the platform secret and makes the call on the builder's behalf; a scope with no owner
    of record refuses actionably (409) rather than pretending. Surfaced as
    `substrat scope provision <scopeId>`, authenticated with the builder's existing CP token.

  - **`scope restore` is actionable.** The CLI now surfaces the control plane's `detail` on a
    failed restore instead of collapsing it to a bare message.

  Demo verticals `meridian` and `manyfold` carry the reference `/internal/reconcile` handler.
  Console visibility of provisioning state (roles-only / unprovisioned) is a follow-up.

## 0.3.2

### Patch Changes

- d696b78: Builder-facing recovery for a scope stranded at "roles projected, zero tuples" (#332).

  A CP-less hosted scope could be left with its role definitions projected and
  `permission_source = 'local'` but no principal holding a role — so strict local
  enforcement evaluated against an empty tuple table, every login was denied, and the
  builder who owned the vertical had no lever to fix it (`/internal/provision` is gated by
  the platform's secret, which is correctly never theirs). This closes the hole with a
  prevention and a repair, and never hands a builder `PLATFORM_SECRET`.

  - **Provision is atomic now.** `applyProjection` gains an additive `scopeTuples` argument,
    and `provisionScopeLocal` writes the owner's role grant in the **same** enqueued unit as
    the enforcement flip rather than a follow-up `writeTuple` — so a drop between the two can
    no longer strand a scope. An empty-tuple **guard** refuses to switch on strict local
    enforcement when roles are projected but no live principal→role grant exists (across
    scope- and tenant-level tuples), backstopping every projection path.

  - **The vertical remembers its owner.** `@substrat-run/vertical-auth`'s IdentityDO adds a
    durable `owner_of_record` seat (set at provision, never consumed — unlike `pending_owner`,
    which the first login claims). It lives in the per-tenant IdentityDO, a different DO from
    the scope's data DO, so it survives a scope-DO storage wipe (e.g. a promote, #321).

  - **A builder can trigger the repair.** New `POST /tenants/:tenantId/scopes/:scopeId/provision`
    on the control-plane API — builder-reachable (allowlisted **and** ownership-checked: a
    builder may only reconcile a scope running a vertical its own tenant owns) — re-gathers the
    tenant's entitlements and delegates to the vertical's new `/internal/reconcile`, which
    re-sources the owner from `owner_of_record` and re-runs the idempotent provision. The CP
    holds the platform secret and makes the call on the builder's behalf; a scope with no owner
    of record refuses actionably (409) rather than pretending. Surfaced as
    `substrat scope provision <scopeId>`, authenticated with the builder's existing CP token.

  - **`scope restore` is actionable.** The CLI now surfaces the control plane's `detail` on a
    failed restore instead of collapsing it to a bare message.

  Demo verticals `meridian` and `manyfold` carry the reference `/internal/reconcile` handler.
  Console visibility of provisioning state (roles-only / unprovisioned) is a follow-up.

## 0.3.1

### Patch Changes

- 2bdd22b: Custom-hostname issuance end-to-end + registrable-suffix (PSL) enforcement (#305).

  Binding a custom domain to a surface is no longer a bare `pending` row that a human flips
  to `active` by hand. The control plane now drives Cloudflare for SaaS through the real
  lifecycle — `pending → verifying → active | failed` — and enforces the registrable-suffix
  isolation D-35 has always specified but never checked in code.

  - **A `CustomHostnameProvisioner` seam** (`packages/control-plane-api/src/custom-hostnames.ts`)
    wraps the Cloudflare `custom_hostnames` API in pure web-standard `fetch`, injected into
    `createControlPlaneApi` exactly like the WfP uploader — so the transport holds no
    Cloudflare credential and the builder never holds one (D-34). Binding a **custom** domain
    calls `create` (→ `verifying`, storing the DNS records the tenant must publish); a
    **platform** mint under `PLATFORM_BASE_DOMAINS` rides the wildcard cert and goes straight
    to `active` with no per-hostname call.

  - **A scheduled reconcile pass** (`reconcilePendingHostnames`, wired into the control-plane
    worker's `scheduled()`) polls every `verifying` domain to `active`/`failed` and retries
    any stuck `pending` custom bind — issuance self-heals without a human. A new
    `POST /hostnames/:hostname/verify` route (and `substrat hostnames verify`, and the
    dashboard's _Check again_) re-polls on demand.

  - **New `@substrat-run/psl`** vendors the Public Suffix List + the canonical matching
    algorithm (no runtime fetch, web-standard only). `resolveCookieDomain` now rejects a
    cookie whose Domain is a public suffix (`co.uk`, `pages.dev`) — a real guard where the old
    label-count check waved multi-level suffixes through — and `bindHostname` refuses a custom
    domain that is a bare public suffix.

  - **Contract + storage.** `hostnameBinding` gains `customHostnameId` and `validationRecords`
    (additively, defaulting to null/[]), plus a `verifying` status and a `dnsRecord` shape. Both
    adapters get the two columns (additive ALTER), a `setHostnameIssuance` writer, and a
    `status` filter on `listHostnames` (index-backed) for the reconcile pass.

  - **The dashboard Domains view is wired to the live control plane** (`/api/domains`): list,
    add a custom domain (shows the DNS records to publish), _Check again_, and remove — no more
    mock rows. Removing a custom domain releases the Cloudflare custom hostname.

  Absent a SaaS zone (dev / self-host), a custom bind records `pending` and issuance simply
  does not run — existing behavior is unchanged until `CF_SAAS_ZONE_ID` is configured.

- Updated dependencies [2bdd22b]
  - @substrat-run/psl@0.2.0

## 0.3.0

### Minor Changes

- d4bf108: Shared login across a scope's surfaces (K-26 multi-surface): a delivered
  `substrat:auth.cookieDomain` sets the session cookie with `Domain=<parent>` instead of
  host-only, so sibling surfaces (`crm.egeryds.se`, `eka.egeryds.se`, …) share one session.
  The signing secret was already per-tenant (DO-minted), so the attribute is the only thing
  that was missing. Both providers honor it — the OIDC relying party directly, Better Auth
  via `advanced.crossSubDomainCookies` (the worker relays the choice to the IdentityDO as a
  header, re-validated there). `resolveCookieDomain` validates the domain against the
  request host where the cookie is set (equal or proper-suffix at a label boundary, no bare
  TLDs); an invalid domain degrades to host-only rather than breaking sign-in. Setting the
  domain cookie also clears the host-only shadow, and logout clears both variants. Meridian
  threads `cookieDomain` through its `authChoice` as the reference wiring.

## 0.2.1

### Patch Changes

- Updated dependencies [0caa0a9]
  - @substrat-run/oidc-rp@0.4.0

## 0.2.0

### Minor Changes

- d93e690: Detachable vertical auth (docs/architecture/vertical-auth-detach.md): auth moves out of the
  verticals and becomes an install-time choice — a team Auth Server app or any external
  OIDC issuer — with `builtin` (embedded Better Auth) as the unchanged default.

  **auth-server** is now a real multi-instance vertical: one issuer DO per scope behind
  the router (own users, signing secret, JWKS per install), the fixed-name single issuer
  standalone. It implements the K-31 surface (`/internal/provision`, `/internal/configure`)
  and answers unknown `/internal/*` paths with JSON — never the SPA fallback that
  surfaced as "Provisioning failed — internal error".

  **Config delivery seam** (control-plane-api): `VerticalClient.configureInstance` +
  `POST /tenants/:t/scopes/:s/configure` deliver per-instance config to the deployment
  holding the scope's DO (bound-version resolution, 501 when there is nowhere to deliver);
  `ProvisionInstanceInput` gains optional `config` so an app arrives configured
  atomically. The dashboard Env tab now delivers after authoring (`delivered` flag).

  **RP flow** (vertical-auth): `oidcRpAuthProvider` — the full server-side
  Authorization-Code + PKCE relying party as an `AuthProvider`, cookie sessions signed
  with a per-tenant DO-minted secret, bearer fallback for API clients. The IdentityDO
  stores platform-delivered per-scope config and keeps the provider-agnostic
  `sub → principal` directory (TOFU owner claim + invites) under every mode. Meridian
  selects its provider per scope from the delivered `substrat:auth`; its SPA renders a
  redirect sign-in and invite-accept in OIDC mode. jose is bumped to v6 so node JWKS
  fetching goes through `fetch`, matching workerd.

  **Install-time identity** (dashboard): the New-app form's Identity section — builtin,
  a team Auth Server (the app is auto-registered there via RFC 7591 dynamic client
  registration against its real bound hostname), or an external issuer. Wiring failures
  mark the app failed with the reason on its audit trail.

### Patch Changes

- Updated dependencies [d93e690]
  - @substrat-run/oidc-rp@0.3.0

## 0.1.0

### Minor Changes

- 12acc59: **First-run setup state + invite-only sign-up (Phase 1).** A freshly-provisioned instance
  now has an explicit setup state instead of a bare login: the IdentityDO exposes
  `needsSetup(scopeId)` (the owner seat is still unclaimed), and Meridian uses it to

  - serve a **"Set up your workspace — create the admin account"** screen on first visit
    (`/api/me` returns `{ status: 'needs-setup' }` while unclaimed), instead of a plain
    sign-in that gives no hint the first sign-up becomes the admin; and
  - **close open sign-up once the admin has claimed it** — after first-run, a stranger who
    finds the URL can no longer self-register (`/api/auth/sign-up/email` returns 403). The
    window is exactly "owner unclaimed", so it closes the instant the admin is created.

  The claim itself is unchanged (trust-on-first-use — first completed setup wins). The
  member-invite path (how teammates join after setup) is the Phase 2 follow-up.

- fa0707c: **Member invites (Phase 2) — the post-setup join path.** Once a workspace is set up it's
  invite-only; this adds the flow that lets teammates in:

  - **IdentityDO** gains an `invite` directory (token _hash_ only) + `createInvite` /
    `listInvites` / `inviteExists` / `revokeInvite` / `claimInvite`. Claiming binds the
    invitee's subject to a pre-minted member principal.
  - **`CloudflareScopeHost.assignScopeRole(scopeId, principal, roleKey)`** — the member half
    of `provisionScopeLocal`'s owner grant: grant a principal a role at scope level so its
    permissions resolve from the scope's own storage (covered by two new workerd tests).
  - **Meridian**: admin-only `POST/GET /api/invites` (+ `…/revoke`) mint/list invites (role
    granted at creation, one-time accept link returned, plaintext token never stored);
    `POST /api/accept-invite` claims one while signed in; the sign-up gate also opens for a
    valid `?invite=` token. SPA: an admin **Access** tab (invite at a role, copy the link,
    revoke) and an **AcceptInvite** screen driven by `?invite=<token>`.

  Roles a teammate can be invited at are this vertical's roles (hr-admin | manager | payroll);
  employees (HR records) remain separate.

- 6a0e253: **Pluggable, config-selected auth for verticals — a new `@substrat-run/vertical-auth` package, and Meridian on it.**

  Auth is now a config choice behind a small contract, isolated per tenant, with no shared `AUTH_DB`.

  - **`@substrat-run/vertical-auth`** (new): the `AuthProvider` contract (`handle` + `resolve`); an
    OIDC provider (`oidcAuthProvider` — verifies a bearer JWT against the issuer's JWKS, covering
    Supabase, Auth0, AuthHero, Keycloak); and a per-tenant **`IdentityDO`** — Better Auth over
    `drizzle-orm/durable-sqlite` (its own SQLite, one DO per tenant) plus the provider-agnostic
    `sub → principal` directory (`setPendingOwner` / `resolvePrincipal`). Source-exported (`.`,
    `./provider`, `./oidc`).

  - **Meridian** consumes it. The worker picks the provider by config (`AUTH_PROVIDER=better-auth-do`
    default, or `oidc` + `OIDC_ISSUER`/`OIDC_AUDIENCE`); the app never learns which. `/internal/provision`
    seeds the owner seat, and the first login **claims** it (the installer becomes `hr-admin`) —
    provider-agnostically. The shared D1 `AUTH_DB` and its identity directory are gone; `wrangler
--dry-run` shows only the `SCOPE` + `AUTH` (IdentityDO) Durable Objects, so the worker still passes
    the sandbox contract and is pushable to the dispatch namespace.

  Verified on real workerd (Better Auth path): provision → sign-up → invoke claims the owner seat →
  `hr-admin` op succeeds → `/api/me` returns the claimed principal. OIDC verified with jose
  (mint+verify): valid → subject; no token / wrong issuer / expired → null. 21 Meridian node tests pass.

  Follow-ups (see `demos/meridian/DEPLOY.md`): fold the `hr/whoami` shape back into `/api/me` so the
  owner lands on the Admin surface; adopt the package in Callout; remove the now-dead `src/auth.ts` /
  `src/auth-schema.ts`.
