---
'@substrat-run/control-plane-api': minor
'@substrat-run/vertical-auth': minor
'@substrat-run/oidc-rp': minor
'@substrat-run/demo-auth-server': minor
'@substrat-run/demo-meridian': minor
'@substrat-run/dashboard': minor
'@substrat-run/boundary-lint': patch
---

Detachable vertical auth (docs/design/vertical-auth-detach.md): auth moves out of the
verticals and becomes an install-time choice — a team Auth Server app or any external
OIDC issuer — with `builtin` (embedded Better Auth) as the unchanged default.

**auth-server** is now a real multi-instance vertical: one issuer DO per scope behind
the router (own users, signing secret, JWKS per install), the fixed-name single issuer
standalone. It implements the K-31 surface (`/internal/provision`, `/internal/configure`)
and answers unknown `/internal/*` paths with JSON — never the SPA fallback that
surfaced as "Provisioning failed — internal error".

**Config delivery seam** (control-plane-api): `VerticalClient.configureInstance` +
`POST /tenants/:t/scopes/:s/configure` deliver per-instance config to the deployment
holding the scope's DO (bound-version resolution, 501 when there is nowhere to deliver);
`ProvisionInstanceInput` gains optional `config` so an app arrives configured
atomically. The dashboard Env tab now delivers after authoring (`delivered` flag).

**RP flow** (vertical-auth): `oidcRpAuthProvider` — the full server-side
Authorization-Code + PKCE relying party as an `AuthProvider`, cookie sessions signed
with a per-tenant DO-minted secret, bearer fallback for API clients. The IdentityDO
stores platform-delivered per-scope config and keeps the provider-agnostic
`sub → principal` directory (TOFU owner claim + invites) under every mode. Meridian
selects its provider per scope from the delivered `substrat:auth`; its SPA renders a
redirect sign-in and invite-accept in OIDC mode. jose is bumped to v6 so node JWKS
fetching goes through `fetch`, matching workerd.

**Install-time identity** (dashboard): the New-app form's Identity section — builtin,
a team Auth Server (the app is auto-registered there via RFC 7591 dynamic client
registration against its real bound hostname), or an external issuer. Wiring failures
mark the app failed with the reason on its audit trail.
