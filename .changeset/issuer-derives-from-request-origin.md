---
"@substrat-run/demo-auth-server": patch
---

feat(auth-server): the issuer derives itself from the request hostname — `PUBLIC_ORIGIN` becomes an optional pin

`PUBLIC_ORIGIN` was `required: true`, so installing the auth server forced the operator to
type an origin — and a typo'd or not-yet-routable custom domain (no DNS record) made
discovery advertise an issuer that doesn't route anywhere. Client registration against it
then failed with Cloudflare 530 / error 1016, attributed to the wrong hostname.

The runtime already derived the issuer per request (`cfg.PUBLIC_ORIGIN ?? origin`), so the
declaration now matches it: blank is the default and the issuer answers as whatever
hostname the router bound to it (platform mint or custom domain), which keeps OIDC
discovery self-consistent on every door — the spec requires the advertised `issuer` to
equal the URL discovery was fetched from. Set the pin only when the request origin can't
be trusted (standalone behind a rewriting proxy).
