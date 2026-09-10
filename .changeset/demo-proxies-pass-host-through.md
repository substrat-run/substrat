---
---

Nine demo dev proxies were rewriting the `Host` header, which sent every OIDC login
callback to the API's port instead of back to the app. Only private packages (the demos,
the docs site) are affected, so nothing published changes — but `pnpm lint:vite-proxy` is
new, and it refuses the shorthand that caused it.
