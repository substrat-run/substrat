---
'@substrat-run/control-plane': patch
'@substrat-run/dashboard-web': patch
---

Default custom-hostname DCV to HTTP (single-CNAME issuance).

Cloudflare-for-SaaS certificate validation now defaults to the `http` method instead of
`txt`. A tenant binding a custom domain publishes a **single** record — the routing CNAME —
and Cloudflare serves the validation token at its edge once the CNAME is live, so issuance is
hands-off (nothing for the platform to serve). The method is overridable per environment via
`CF_SAAS_SSL_METHOD` on the control-plane worker; set it to `txt` for the previous two-record
flow that can validate before the CNAME resolves. The dashboard's Domains preview mock is
refreshed to the single-record shape and the `cname.substrat.run` routing target.
