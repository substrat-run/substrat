---
'@substrat-run/control-plane': patch
'@substrat-run/builder': patch
---

The committed wrangler configs no longer name any account-specific id, and the control plane drains its scopes' events to Tier 2.

This repo is public and forkable, and two kinds of value sit in a worker's bindings. A **name** — `substrat-verticals`, `substrat-scope-backups` — is portable: a fork keeping it creates its own resource under that name and works. An **opaque id** is not. A `database_id` addresses exactly one account, so a fork inherited a config pointing at somebody else's database.

The three ids now live in `secrets/platform.<env>.env` beside the secrets, and `tools/wrangler-config.mjs` substitutes them into a gitignored `wrangler.generated.jsonc` that deploys point at. Values resolve from `process.env` first and the env file second, which is what lets one tool serve both paths — CI holds them as GitHub Actions variables, a local `cf:deploy` reads the file. The generator refuses to emit a config containing an unresolved placeholder, because a `${…}` reaching `wrangler deploy` is not an error wrangler can explain: `database_id` would simply be a string matching no database.

`pnpm lint:wrangler-config` keeps it true, and judges shape rather than a list of known values — anything looking like a UUID or a 32-hex id fails, so pasting a *new* id back in is caught too.

The control plane also binds the Tier-2 event stream and passes `eventSink` to the platform sweep, so the drain phase that has been implemented on both adapters finally has somewhere to ship. Unbound it stays skipped, which keeps a self-host that ships nowhere a supported deployment.

That binding is carried in `wrangler.deploy.json` and spliced in at a marker rather than living in the committed config, because `wrangler.jsonc` is also what the workers vitest pool parses, and the catalog pins that pool's wrangler to 4.44 — which predates the `pipelines[].stream` shape and rejects the whole config on sight. It is not only a workaround: a test plane must not hold the Tier-2 stream either, since writing into the lake that answers audit is exactly what a test deploy should not be able to do.
