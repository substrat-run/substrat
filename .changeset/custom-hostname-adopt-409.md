---
'@substrat-run/control-plane-api': patch
---

Binding a custom domain whose Cloudflare custom hostname already exists in the SaaS zone (for example, one left behind by an earlier unbind) no longer fails with "Duplicate custom hostname found". The existing hostname is adopted, so **Check again** repairs a domain stuck in that state.
