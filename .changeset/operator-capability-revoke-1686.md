---
'@substrat-run/contracts': minor
'@substrat-run/kernel': minor
'@substrat-run/adapter-sqlite': minor
'@substrat-run/control-plane-client': patch
'@substrat-run/adapter-cloudflare': minor
'@substrat-run/vertical-host': minor
'@substrat-run/vertical-auth': patch
'@substrat-run/control-plane-api': minor
'@substrat-run/control-plane': patch
'@substrat-run/console': patch
'@substrat-run/docs': patch
---

An operator can revoke a capability on a hosted scope (part of #1686). Before this, the platform's `revokeCapability` refused every scope served by a vertical's own deployment, so a leaked link share could be seen in the console but not stopped.

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
