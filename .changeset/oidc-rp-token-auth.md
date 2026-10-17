---
"@substrat-run/oidc-rp": minor
---

The client secret can be presented to the token endpoint as HTTP Basic. `OIDC_TOKEN_AUTH` (and `OIDC_ALT_TOKEN_AUTH` for the alternate issuer) is `post`, the default and what the package has always sent, or `basic`. An issuer holds the method per client as registered and refuses the other, so a client registered for `client_secret_basic` could not log in before: its token exchange was answered `invalid_client`. With `basic` the id and secret are form-urlencoded, joined and sent in an `Authorization` header, and the secret is left out of the body. Any other value refuses the login. `tokenAuthOf` is exported.
