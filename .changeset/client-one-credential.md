---
"@substrat-run/control-plane-api": patch
---

`ControlPlaneClient` sends one credential per request: with a `serviceToken` it presents only `x-service-token` (the control plane resolves the subject from the token and never consulted the actor header there); without one it presents the dev-only `x-platform-actor` header as before. The console's `?actor=`/localStorage dev-actor override is now a dev-build-only affordance, tree-shaken out of production bundles.
