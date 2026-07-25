# @substrat-run/cli

The `substrat` CLI — authenticated deploy tooling. You **push** a vertical to the platform,
then manage its versions and channels. It is the client half of the
[self-serve deploy](/guide/deploying) flow: it builds your worker locally and POSTs a bundle;
the [control plane](/platform/control-plane) holds the Cloudflare credential and does the
upload, so **you never hold a platform token** (decision D-34).

Published to npm as [`@substrat-run/cli`](https://www.npmjs.com/package/@substrat-run/cli),
Apache-2.0. For the narrative walkthrough — including *why* push is not deploy — see
[Deploying a vertical](/guide/deploying).

## Install

```bash
npm install -g @substrat-run/cli    # or pnpm add -g @substrat-run/cli
substrat --help
```

The package has no runtime dependencies and ships web-standard + `node:*` only. It needs Node
≥ 20 and, for `push`, `npx wrangler` available in the vertical's directory (it builds with
`wrangler deploy --dry-run`).

## Commands

| Command | What it does |
|---|---|
| `substrat login` | Sign in via the browser (per-human), or store a CI service token with `--token`. |
| `substrat whoami` | Print who you are and the workspaces you can build for. |
| `substrat push <dir> --slug <s> --version <v>` | Build the vertical in `<dir>` and push a **pending** version. |
| `substrat promote <slug> --channel dev\|staging --version <id>` | Point a non-prod channel at a version. |
| `substrat versions <slug>` | List a vertical's versions + which channels point where. |
| `substrat scope pull <scopeId>` | Pull a scope's data to a local SQLite file — masked by default, `--full` is break-glass. |

Options on any command: `--cp <url>` (control-plane API base), `--token <tok>` (a service
credential), `--tenant <id-or-slug>` (which workspace to act for).

### `login`

```bash
substrat login                     # browser loopback (PKCE) — a per-human session
substrat login --token <SERVICE_TOKEN>   # CI: store a service-actor credential
```

The browser flow starts a one-shot `127.0.0.1` server, opens the platform's CLI broker, signs
you in through [AuthHero](/concepts/identity), and exchanges a PKCE-bound `code` for a session
token — the token never transits a URL. On success the CLI also resolves your workspace(s) and
stores a default (prompting if you belong to several). Everything lands in
`~/.substrat/config.json` (mode `0600`).

### `push`

```bash
substrat push ./my-vertical --slug helpdesk --version 0.1.0 [--name "Helpdesk"]
```

From the vertical's directory (the one with `wrangler.jsonc`): builds the bundle, reads the
declared surface (your own DO classes, D1 databases, compatibility date/flags, entry module),
computes the three digests, and POSTs to `{cp}/verticals/{slug}/deploy`. The slug is **bare** —
the control plane forms the registry id `<workspace>/<slug>` from your session (see
[the prefix](/guide/deploying#the-workspace-prefix)). The version lands **pending**; admission
is a separate, human step.

### `promote`

```bash
substrat promote helpdesk --channel staging --version 01J…
```

Moves an **admitted** version onto a channel. You self-serve `dev` and `staging`; `prod` is
refused — production promotion and admission stay a platform decision (model B).

### `scope pull`

```bash
substrat scope pull <scopeId> [--full] [--out <dir>] [--tenant <id-or-slug>]
```

Brings a scope's data to your local inner loop ([snapshots](/concepts/snapshots)): downloads
the scope's dump from the control plane and writes a **real SQLite file** —
`.substrat/<tenant>__<scope>.sqlite`, the exact file shape
[`adapter-sqlite`](/reference/adapter-sqlite) stores scopes in, so a local harness runs the
identical vertical against it. On node < 22.13 (no `node:sqlite`) the dump lands as JSON with
a notice instead.

The pull crosses the platform's trust boundary on purpose, so the server side is the gate:

- **Masked by default** — PII-named columns and payload fields are redacted; ids and numbers
  pass through, which is what keeps the copy debuggable. `--full` is the explicit break-glass
  for full fidelity, and the CLI prints a treat-as-production warning.
- **Audited** — every pull writes an access-log entry against your actor.
- **Jurisdiction-checked** — a scope pinned tighter than `global` is refused: pulling would
  move its data outside the pin.

One-way by design: you pull and diverge; nothing syncs back.

## Auth resolution

At request time the CLI resolves, in order:

- **Credential** — explicit `--token` / `SUBSTRAT_SERVICE_TOKEN` (a service actor, for CI) → a
  stored browser session (sent as `Authorization: Bearer`) → a stored service token.
- **Control-plane URL** — `--cp` → `SUBSTRAT_CP_URL` → the stored config (default
  `https://console.substrat.net/api`).
- **Workspace** (browser session only) — `--tenant` → `SUBSTRAT_TENANT` → the stored default,
  sent as `x-substrat-tenant`.

You are always authenticated **as yourself** — a push is attributable to the human or service
that ran it, never a hand-picked actor.

## Config file

`~/.substrat/config.json`, written `0600`:

```json
{
  "controlPlaneUrl": "https://console.substrat.net/api",
  "bearerToken": "…",        // a browser session (per-human)
  "serviceToken": "…",       // a machine credential (CI)
  "defaultTenant": "acme-co" // the workspace push/promote act for
}
```

It is a home-dir file, never committed to a repo.
