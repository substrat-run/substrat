---
'@substrat-run/demo-manyfold': patch
---

A hosted Manyfold now receives its per-install identity (#2201). `/internal/configure` used to answer 501, so a delivered sign-in choice and the Env tab's values never reached it and it ran on its binding-default OIDC. It now stores them per site, and an install with a delivered `substrat:auth` signs in at that issuer. A site with nothing delivered keeps the binding default. A delivered issuer that is refused (not https, not a valid identifier) answers 503 for that install instead of falling back. Sign-ins bound under the old issuer's subject do not resolve at a different issuer until the person is re-bound.
