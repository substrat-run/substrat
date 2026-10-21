---
"@substrat-run/contracts": minor
"@substrat-run/vertical-host": minor
"@substrat-run/vertical-auth": minor
---

Discover the per-instance sign-in issuer through the standard auth route by default when mounting MCP. Publish protected-resource metadata and challenge unauthenticated clients with its URL, so team-auth-server clients can register themselves without per-vertical discovery wiring. Existing deployments must update both host and auth packages and redeploy. Explicit issuer overrides, audience validation, and operation permissions are preserved.
