---
'@substrat-run/contracts': minor
'@substrat-run/vertical-host': minor
'@substrat-run/control-plane-api': minor
'@substrat-run/control-plane': patch
---

The control plane refuses to supply a scope sweeper to a bundle that registers no scope host for it (#1646).

The platform's sweeper runs the host a vertical's `mountPlatformSurface` registers. A bundle built on a `@substrat-run/vertical-host` from before that registration, or one that never mounts `mountPlatformSurface`, registers no host and never fills the sweeper's list of scopes. Its schedules would never run, and nothing would log an error. `substrat push` already refused this when it could find the installed vertical-host. The push route now refuses it too (422), so the check also covers a push with `--allow-unswept-schedules`, a vertical-host the CLI could not resolve, and a push from an older CLI. The fix is to update `@substrat-run/vertical-host`, or to export your own `defineScopeSweeperDO` class bound as a store. Promote, re-serve and rollback still reuse the decision recorded at push, so none of them can refuse.

New exports: `PLATFORM_SWEEP_HOST_KEY` (contracts) and `SCOPE_SWEEP_HOST_KEY` (vertical-host), the global registry key. A test holds them equal.
