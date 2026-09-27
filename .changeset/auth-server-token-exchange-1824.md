---
'@substrat-run/demo-auth-server': minor
---

The auth server answers RFC 8693 token exchange at its token endpoint, so one app of a team can call another app's MCP endpoint on behalf of that app's signed-in user.

It happens in two steps. The host app trades the user's token for a five-minute assertion addressed to the acting app. The acting app trades that assertion for a five-minute access token for one of the host's MCP resources. The access token names the user as its subject and the acting app in `act`, and its scope is never wider than the delegation allows. Neither step issues a refresh token.

Neither step works unless the platform has said the host delegates to that app, and for which permissions. The platform delivers that per host app through `/internal/configure` (`substrat:delegations:<host scope>`), and no client can grant itself one. Both steps re-read the grant, so revoking it refuses the next exchange, and a token already issued lapses within five minutes. Both apps must be registered for this auth server by the platform and belong to the same team. Clients that registered themselves are refused.

Discovery now lists `urn:ietf:params:oauth:grant-type:token-exchange` in `grant_types_supported`. Every other grant reaches the token endpoint exactly as before.
