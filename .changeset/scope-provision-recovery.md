---
'@substrat-run/control-plane-api': minor
'@substrat-run/adapter-cloudflare': patch
'@substrat-run/vertical-auth': patch
'@substrat-run/cli': patch
---

Builder-facing recovery for a scope stranded at "roles projected, zero tuples" (#332).

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
