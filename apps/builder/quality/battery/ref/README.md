# Shared lists

A todo app for lists you own and share by email. Node 22 and its built-in SQLite; no dependencies.

    npm start

| Variable | Default | What |
|---|---|---|
| `PORT` | `4310` | Where it listens |
| `OIDC_ISSUER` | `http://localhost:18800` | The OpenID Connect provider people sign in with |
| `OIDC_CLIENT_ID` | `shared-lists` | The client id it signs in as |
| `OWNER_EMAIL` | `alice@example.com` | The owner: the one person who is a member without an invitation |
| `DB_PATH` | `data/app.db` | The SQLite file; delete it for a fresh start |
| `OUTBOX` | `outbox` | Outgoing email lands here, one JSON file per message |

Sign in at `/login`. The API is described at `/openapi.json` (reference page at `/api/docs`) and
accepts a session cookie or a bearer access token from the provider. The MCP endpoint is
`/api/mcp`. Invited people become members when they sign in with the address the invitation went to.
