---
"@substrat-run/adapter-cloudflare": patch
---

Return typed `not_found` errors for missing or foreign-tenant scopes across the Cloudflare adapter's scope guards, including the control plane's access and lifecycle-transition checks, preserving existing messages and validation order.
