---
'@substrat-run/dashboard': patch
---

A custom domain can no longer be bound under one of the deployment's own platform
zones (#973). The Domains tab's custom-domain path refused only two bases — the
platform default and the app's own zone — because the call chain had no way to read
the deployment's configured `PLATFORM_BASE_DOMAINS`; a deployment serving a zone
outside those two accepted a custom hostname under it, and the control plane then
classified the result as a platform hostname and marked it active. The worker now
reads that var and hands the list down to the bind. The three sources are unioned,
so configuring the var can only widen the refusal, never narrow it, and a deployment
that leaves it unset behaves exactly as before.
