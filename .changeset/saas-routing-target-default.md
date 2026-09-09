---
---

The control plane's default Cloudflare-for-SaaS routing target becomes `cname.<base domain>` —
the record production publishes — instead of an `edge.<base domain>` that resolves nowhere.
`apps/control-plane` is a private workspace member, so nothing is released by this change.
