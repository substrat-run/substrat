# Platform secrets

One flat env file per environment → every platform worker's secrets, dev and prod.
Keep the filled files in a password manager; only the `.example` templates are committed
(`secrets/*.env` is gitignored).

## Workers covered

| Worker | Dir | Deployed name (prod / test) |
|---|---|---|
| control-plane | `apps/control-plane` | `substrat-control-plane` / `…-test` |
| builder | `apps/builder` | `substrat-builder` / `…-test` |
| dashboard | `apps/dashboard` | `substrat-dashboard` / `…-test` |
| router | `apps/router` | `substrat-router` / `…-test` |

`apps/docs` is a static Pages site (no secrets). Demo verticals keep their own `.dev.vars`
— out of scope here. (Every demo vertical is OIDC-only and runs no credential store at
all; `demos/auth-server`, the issuer, is the one workspace member that still runs Better
Auth.)

## Connector credentials are a different file, on purpose

`secrets/connectors.env` (template: `connectors.env.example`) holds the provider
credentials the connectors' **live test suites** use — Fortnox, Scrive, and whatever comes
next — one file, keyed `<PROVIDER>_*`. It replaces a `.dev.vars` per connector, which does
not scale past two.

**`scripts/secrets.mjs` does not read it and never pushes it, and that separation is the
point.** Everything in `platform.<env>.env` is uploaded to the deployed workers by `push`.
A provider credential must not go there: in production its home is a **sealed connection**
in the directory, opened per (tenant, vertical, provider), which is what keeps a leaked
token to one tenant's one integration instead of the fleet. A provider credential sitting
in a worker's ambient env is the hole [#862](https://github.com/substrat-run/substrat/issues/862)
closed.

So these values do one job: point a local test at a provider's **sandbox**. Fortnox creates
up to 30 test databases; Scrive has a testbed. Each live suite skips when its keys are
absent, so CI stays offline without it.

```bash
cp secrets/connectors.env.example secrets/connectors.env
$EDITOR secrets/connectors.env          # paste the Fortnox portal pair
pnpm fortnox:connect                    # one-time service consent → prints FORTNOX_TENANT_ID
```

Each connector's own `.dev.vars` still works and is overridden by this file, so an existing
checkout keeps running until it is migrated. A `<PROVIDER>_` variable in the environment
beats both — `FORTNOX_CLIENT_ID=… pnpm --filter @substrat-run/connector-fortnox test` runs
the live suite with no file at all, which is how a job holding the credential in a secret
store reaches it.

## Quick start (prod)

```bash
cp secrets/platform.prod.env.example secrets/platform.prod.env
node scripts/secrets.mjs generate              # fill the random shared secrets
$EDITOR secrets/platform.prod.env              # paste OIDC / Cloudflare / GitHub App values
node scripts/secrets.mjs check                 # confirm coverage (names only, no values)
node scripts/secrets.mjs push --env prod       # workers via `wrangler secret bulk`, then the fleet
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
| `secrets.mjs check` | Print the worker→secret map, the store-only keys, and anything the file carries that nothing reads. No values. |
| `secrets.mjs push --env prod\|test` | Upload the file's secrets to each deployed worker, **then** re-put `PLATFORM_SECRET`/`ROUTER_SECRET` on every vertical. Also `pnpm secrets:platform`. |
| `secrets.mjs verticals --env prod\|test` | Just that second step, on its own. |
| `secrets.mjs dev` | Write `apps/*/.dev.vars` from the dev file. |
| `secrets.mjs generate` | Fill blank *generatable* random secrets in the file. |
| flags | `--file <path>` · `--only control-plane\|builder\|dashboard\|router` · `--dry-run` · `--skip-verticals` |

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
| `R2_LAKE_SQL_TOKEN` | `R2_SQL_TOKEN` | — | — |

`PLATFORM_SECRET` and `ROUTER_SECRET` are also injected into every pushed vertical by
the control plane's WfP uploader — verticals need no secret setup of their own, but the
control plane must hold the values (hence they're set here).

Optional keys (`CF_SAAS_ROUTING_TARGET`, `CF_SAAS_SSL_METHOD`, `PLATFORM_BASE_DOMAINS`,
`SECRET_BOX_KEY_ID`, `EMAIL_FROM`, `CP_ACTOR`) are normally wrangler.jsonc `vars`; set
them in the file only to override, and they'll be pushed as secrets that shadow the var.

## Store-only keys (in the file, never pushed)

`push` uploads only what the manifest maps, each key to the worker(s) among the four
(control plane, builder, dashboard, router) that name it — a key in `platform.<env>.env`
that no worker maps goes nowhere. A credential whose home is some *other* service's config
therefore needs saying so out loud, not because it might be pushed but because the
alternative is a key that sits in the file doing nothing and looks exactly like a typo.
`STORE_ONLY` in `scripts/secrets.mjs` names them and `check` prints them under their own
heading; `push` excludes them by construction, since it only ever walks the manifest.

| Key | Where it actually lives |
|---|---|
| `R2_LAKE_CATALOG_TOKEN` | the sink's own config, written once by `scripts/lake-provision.mjs` |
| `R2_LAKE_SEND_TOKEN` | nowhere by default — only a non-Workers sender needs it |

They are recorded here anyway because **Cloudflare never gives a token back**: the same
reason `generate` writes new values into the file before pushing them. A token that exists
only inside a pipeline's config is one you cannot restore an account from.

`check` also now lists any key the file carries that neither a worker nor `STORE_ONLY`
names. That is reported, not fatal — but a misspelled canonical key used to be completely
silent, which is how a "configured" secret can turn out never to have been pushed.

## The Tier-2 lake needs three separate credentials

The Iceberg tier (D-5, `kernel-design` §5.3) is the one place where three
similar-sounding Cloudflare tokens are genuinely not interchangeable, so the prod template
spells each out. The short version:

| Credential | Permission | Who holds it |
|---|---|---|
| catalog | R2 **Admin Read & Write**, scoped to the lake bucket | Cloudflare Pipelines, in the pipeline config |
| query | R2 **Admin Read only**, same bucket | control-plane, as `R2_SQL_TOKEN` |
| send | **Workers Pipeline Send** | only a sender outside Workers |

Two traps worth knowing before debugging one:

- **Object Read & Write does not work for the catalog.** That permission is
  S3-API-only, so a pipeline holding one is created successfully and then fails at its
  first catalog commit — a setup that looks complete and a failure that arrives later.
- **Catalog-vended R2 credentials inherit the token's storage permission.** A token with
  read-only catalog access but read-write storage access can still write objects. So the
  reader is `Admin Read only`, which is read-only on both halves, rather than a
  hand-assembled policy that is only half narrowed.

`scripts/lake-provision.mjs` is where the lake's shape is declared — bucket, namespace,
table, compression, rolling policy, and the pipeline SQL. It speaks to the Pipelines and
R2 account API directly rather than through wrangler, and reads `CF_API_TOKEN` and
`R2_LAKE_CATALOG_TOKEN` out of this file: the catalog token goes into the sink's request
body over TLS, so it reaches neither shell history nor any process's argv (wrangler's only
transport for it is `--catalog-token <value>`, which is a child process's command line for
as long as it runs — redacting the log does not take it out of `ps`). `pnpm lake:check`
dry-runs it against the account: every existing stream, sink and pipeline is fetched and
**compared field by field with the declaration** — schema fields, HTTP auth, format,
compression, rolling policy, namespace, table, SQL — and the run exits non-zero on a
mismatch. `pnpm lake:provision` creates what is missing. Neither changes anything that
already exists, because Cloudflare has no update for a stream's schema or a sink's rolling
policy, and a delete-and-recreate would orphan the Iceberg table the sink is committing
to — drift is reported for a human, since resolving it is never mechanical. The stream
schema itself is generated from the outbox DDL (`pnpm lint:lake-schema`), so a column the
kernel adds reaches the declaration or CI is red.

The shipper itself needs **no credential**: it runs in a platform worker and reaches the
stream through a `[[pipelines]]` binding. Prefer that over the HTTP endpoint wherever the
sender is a Worker — a binding cannot leak, expire, or be rotated out from under you.

The Access Key ID and Secret Access Key that R2 hands you alongside a token are for the
S3-compatible API, which nothing on this path uses. Don't record them: the Secret Access
Key is the SHA-256 of the token value, so they carry nothing the token doesn't.

## Rotation caveats

- **`SECRET_BOX_KEY`** seals stored connection credentials at rest. Replacing it orphans
  every sealed credential (recovery = reconnect each provider). Set once, back up, and
  leave out of any rotation. The `webCryptoSecretBox` a worker deploys holds ONE key and
  `open()` throws on a keyId mismatch; real rotation needs a keyring box plus a re-seal
  sweep, and the keyId field is ready while the implementation is not.
- **`SESSION_SECRET`** (either) signs cookies — rotating signs everyone out.
- **The lake tokens** rotate independently and neither is urgent: replacing
  `R2_LAKE_SQL_TOKEN` interrupts lake queries until the next `push` + deploy, while
  replacing `R2_LAKE_CATALOG_TOKEN` also means re-running the pipeline's sink config —
  `push` cannot do that half, because the token does not live on a worker.
- Rotating **`PLATFORM_SECRET` / `ROUTER_SECRET`** is a TWO-step move, and **`push` now
  runs both** (#979): it updates the platform workers, then re-puts the pair on every
  deployed vertical script in the dispatch namespace. Vertical scripts receive these as
  bindings baked in at deploy (`wfp.ts` `injectSecrets`), so until step 2 runs every
  hosted app rejects the router's node assertion (users locked out) and the control
  plane's `/internal/*` calls 403 (Data tab, config delivery, provisioning). The
  2026-08-01 rotation shipped without step 2 and took the whole hosted fleet down —
  because the rotate script of the day printed the step as a reminder instead of doing
  it. `secrets.mjs verticals --env prod` still exists to run step 2 alone;
  `push --skip-verticals` is the escape when the pair did not change.

## Rotating the three shared tokens

There is no separate rotate script (the one that existed is the paragraph above):

```bash
node scripts/secrets.mjs generate --keys SERVICE_TOKEN,PLATFORM_SECRET,ROUTER_SECRET --force
node scripts/secrets.mjs push --env prod          # workers, then every vertical
pnpm --filter @substrat-run/control-plane cf:deploy
```

`generate` writes the new values into the env file first, on purpose: Cloudflare never
gives a secret back, so a value that lives only in the deployed worker is one you cannot
check with `status`, diff, or restore.
