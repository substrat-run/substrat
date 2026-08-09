---
"@substrat-run/ui": minor
"@substrat-run/console": minor
"@substrat-run/dashboard-web": minor
---

feat(ui,console,dashboard): the dashboard and console refresh themselves — on tab focus, and on a slow poll while visible

Both apps needed a manual browser reload to see anything another actor did
(an install finishing, a teammate's invite, a tenant provisioned from CI).
Stale-while-revalidate fixes that the way react-query/SWR do by default —
refetch on window focus plus a polling interval — inlined as a shared
`useAutoRefresh` hook in `@substrat-run/ui`, since neither app carries a
query library.

- Nothing fires while the tab is hidden: a wall of backgrounded consoles must
  not poll the control plane all day. The catch-up read happens on return.
- `focus` and `visibilitychange` both fire on tab return; a 5s minimum gap
  collapses the pair (and rapid alt-tabbing) into one refresh.
- Background refresh errors are swallowed — no unprompted toasts; each app's
  load() keeps its own error handling.

The console wires it to the app-level directory `load()` at 60s (each load is
a full walk plus the per-tenant entitlements N+1), gated on auth; views derive
from those arrays, so the refresh cascades. The dashboard composes its
existing reloads (apps, members, deployments, catalog) at the 30s default,
gated off in dev-mock/onboarding/invite-block states; the 5s poll while an
install is provisioning stays.
