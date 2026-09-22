---
'@substrat-run/contracts': minor
'@substrat-run/vertical-host': minor
---

A vertical's MCP endpoint accepts a bearer token only if the token was minted for it.

The endpoint `mountOperations` mounts now refuses a JWT whose `aud` does not name the endpoint's own resource identifier, the same string its RFC 9728 document publishes (`https://<host>/api/mcp`, or the `resource` a vertical pins). The answer is a `401` with `error="invalid_token"` and the usual `resource_metadata` challenge. Before, a token that another vertical's endpoint requested from the same issuer was accepted, and so was an `id_token` presented as a bearer, because the resolver behind the endpoint checks only the signature and the issuer. Every vertical on one team auth-server shares that issuer. The check runs before the vertical's resolver and can only refuse: a token with the right audience still has to pass the resolver's own verification. A request with no bearer (a cookie session), or with a bearer that is not a JWT, is still the resolver's to judge.

If you hand an MCP client a token out of band, mint it with the endpoint's URL as its audience. The dev issuer takes `audience` on `/dev/token`.

`@substrat-run/contracts` exports the one computation both ends of the identifier use: `mcpEndpointPath`, `MCP_ENDPOINT_PATH`, `mcpResourceOf`, and `MCP_RESOURCES_CONFIG_PREFIX`, the delivered-config key a team auth-server reads its registered MCP resources from.
