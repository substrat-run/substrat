# Platform secrets

One flat env file per environment → every platform worker's secrets, dev and prod.
Keep the filled files in a password manager; only the `.example` templates are committed
(`secrets/*.env` is gitignored).

## Workers covered

| Worker | Dir | Deployed name (prod / test) |
|---|---|---|
| control-plane | `apps/control-plane` | `substrat-control-plane` / `…-test` |
| dashboard | `apps/dashboard` | `substrat-dashboard` / `…-test` |
| router | `apps/router` | `substrat-router` / `…-test` |

`apps/docs` is a static Pages site (no secrets). Demo verticals use Better Auth and their
own `.dev.vars` — out of scope here.

## Quick start (prod)

```bash
cp secrets/platform.prod.env.example secrets/platform.prod.env
node scripts/secrets.mjs generate              # fill the random shared secrets
$EDITOR secrets/platform.prod.env              # paste OIDC / Cloudflare / GitHub App values
node scripts/secrets.mjs check                 # confirm coverage (names only, no values)
node scripts/secrets.mjs push --env prod       # upload via `wrangler secret bulk`
```

Then **redeploy** the affected workers — a secret takes effect on the next deploy:

```bash
pnpm --filter @substrat-run/control-plane cf:deploy
pnpm --filter @substrat-run/dashboard cf:deploy
pnpm --filter @substrat-run/router cf:deploy
```

Store `secrets/platform.prod.env` in the password manager afterwards. To recover an
account, restore the file and re-run `push` — no per-secret clicking.

## Dev

```bash
cp secrets/platform.dev.env.example secrets/platform.dev.env
node scripts/secrets.mjs generate --file secrets/platform.dev.env
node scripts/secrets.mjs dev                   # writes each worker's .dev.vars
```

`wrangler dev` and the dev servers load `.dev.vars` automatically. Dev values are
throwaway — never reuse a prod secret locally.

## Commands

| Command | What |
|---|---|
| `secrets.mjs check` | Print the worker→secret map and what the file covers. No values. |
| `secrets.mjs push --env prod\|test` | Upload the file's secrets to each deployed worker. |
| `secrets.mjs dev` | Write `apps/*/.dev.vars` from the dev file. |
| `secrets.mjs generate` | Fill blank *generatable* random secrets in the file. |
| flags | `--file <path>` · `--only control-plane\|dashboard\|router` · `--dry-run` |

Root aliases: `pnpm secrets:check`, `pnpm secrets:push`, `pnpm secrets:dev`.

## The name map (why a tool, not `wrangler secret put`)

Several secrets are the **same value under different binding names on different workers**.
The env file holds one canonical key; the tool sets it under each worker's own name.

| Env file key | control-plane | dashboard | router |
|---|---|---|---|
| `SERVICE_TOKEN` | `SERVICE_TOKEN` | `CP_SERVICE_TOKEN` | — |
| `PLATFORM_SECRET` | `PLATFORM_SECRET` | — | `PLATFORM_SECRET` |
| `ROUTER_SECRET` | `ROUTER_SECRET` | — | `ROUTER_SECRET` |
| `OIDC_ISSUER` | `OIDC_ISSUER` | `OIDC_ISSUER` | — |
| `CP_OIDC_CLIENT_ID` / `_SECRET` | `OIDC_CLIENT_ID` / `_SECRET` | — | — |
| `DASH_OIDC_CLIENT_ID` / `_SECRET` | — | `OIDC_CLIENT_ID` / `_SECRET` | — |
| `CP_SESSION_SECRET` | `SESSION_SECRET` | — | — |
| `DASH_SESSION_SECRET` | — | `SESSION_SECRET` | — |
| `CP_PUSH_TOKEN_SECRET` | `PUSH_TOKEN_SECRET` | — | — |
| `CF_API_TOKEN` | `CF_API_TOKEN` | — | — |
| `CF_ACCOUNT_ID` | `CF_ACCOUNT_ID` | — | — |
| `CF_SAAS_ZONE_ID` | `CF_SAAS_ZONE_ID` | — | — |
| `SECRET_BOX_KEY` | — | `SECRET_BOX_KEY` | — |
| `GITHUB_APP_ID` / `_SLUG` / `_PRIVATE_KEY` | — | same names | — |

`PLATFORM_SECRET` and `ROUTER_SECRET` are also injected into every pushed vertical by
the control plane's WfP uploader — verticals need no secret setup of their own, but the
control plane must hold the values (hence they're set here).

Optional keys (`CF_SAAS_ROUTING_TARGET`, `CF_SAAS_SSL_METHOD`, `PLATFORM_BASE_DOMAINS`,
`SECRET_BOX_KEY_ID`, `EMAIL_FROM`, `CP_ACTOR`) are normally wrangler.jsonc `vars`; set
them in the file only to override, and they'll be pushed as secrets that shadow the var.

## Rotation caveats

- **`SECRET_BOX_KEY`** seals stored connection credentials at rest. Replacing it orphans
  every sealed credential (recovery = reconnect each provider). Set once, back up, and
  leave out of any rotation. See `tools/set-platform-secrets.sh` for the detail.
- **`SESSION_SECRET`** (either) signs cookies — rotating signs everyone out.
- Rotating **`PLATFORM_SECRET` / `ROUTER_SECRET`** requires redeploying the control plane
  and re-pushing verticals (their injected copies change). `tools/set-platform-secrets.sh`
  is the fresh-random rotate path for just those three shared tokens.
