---
'@substrat-run/contracts': minor
'@substrat-run/vertical-host': minor
'@substrat-run/adapter-cloudflare': minor
'@substrat-run/control-plane-api': minor
'@substrat-run/cli': minor
'@substrat-run/control-plane': minor
---

The platform supplies the scope sweeper that runs a vertical's declared schedules (#1902).

A vertical that declares `schedules` no longer has to export `defineScopeSweeperDO`, bind a `SWEEPER` store, or call `noteScope`/`forgetScope` from its platform hooks. When a version declares schedules and its worker entry exports no sweeper, the uploader adds one: the class `SweeperDO`, bound as `SWEEPER`, its migration, and the platform entry's re-export of it. The class is generated from `defineScopeSweeperDO` into `platform-entry.generated.ts` (`pnpm lint:platform-entry --check`).

- `mountPlatformSurface` registers the `hostFor` it is given, which is the host the supplied sweeper runs. It adds a scope to the supplied sweeper's roster after provision and reconcile, and removes it after delete-scope, when the upload sets `SUBSTRAT_SCOPE_SWEEPER`. New exports: `registerScopeSweepHost`, `registeredScopeSweepHost`, `platformSweeperOf`, `PLATFORM_SWEEPER_VAR`.
- `substrat push` reads the entry's own sweeper classes from source and sends them as the manifest's new `sweeperClasses` (`[]` for none). The push route decides from that declaration, never from the bundle's bytes, and decides once: the answer is recorded with the version (the stored manifest's `platformSweeper`), and promote, re-serve and backout reuse it without re-deciding, so they can never refuse over it. A version pushed before this keeps exactly what it had. An own sweeper is kept, and the push is refused (422) if no binding names it. The platform's names, bound to something else, are refused rather than overwritten. A push from an older CLI falls back to the conventional names (`SWEEPER` bound to `SweeperDO` is the vertical's own, neither means none), and refuses a half-match.
- Every control-plane response carries `x-substrat-platform-features: scope-sweeper` (`PLATFORM_FEATURES_HEADER`, `PLATFORM_FEATURE_SCOPE_SWEEPER` in contracts). Before uploading a version that leaves the sweeper to the platform, `substrat push` checks for it, and refuses when the control plane does not list it, since an older control plane would accept the version and never run its schedules.
- A vertical that drops its own `SweeperDO` keeps the same Durable Object namespace on its serving script, so its roster and its armed alarm carry over and the in-place migration is empty.
- The push gate (and `lint:schedule-sweeper`) no longer refuses "no sweeper". It refuses an own sweeper nothing binds, the platform's names taken, or an installed `@substrat-run/vertical-host` too old to register the host.
- `defineScopeSweeperDO` checks ids with a pattern instead of the contracts schemas, so the supplied module carries no zod.
- The `npm create substrat` template still wires its own sweeper, which keeps working unchanged. It drops it once a control plane carrying this is live, since `substrat push` refuses to leave the sweeper to a control plane that does not supply one.
