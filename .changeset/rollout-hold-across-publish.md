---
'@substrat-run/control-plane-api': patch
---

A push or a raw version publish that declares a scope store keeps its shared hold on the store driver until the version is published, so a rollout that starts meanwhile waits (409) instead of missing that vertical (#2816).
