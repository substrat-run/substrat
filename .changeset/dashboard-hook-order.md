---
'@substrat-run/dashboard': patch
---

Fix a crash on load (React #310): the `oidcProviderSlugs` useMemo introduced in #431 sat below the session-mode early returns, so the hook count changed once the session resolved. Hoisted above the early returns with the other hooks.
