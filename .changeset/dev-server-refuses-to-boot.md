---
'@substrat-run/demo-callout': patch
'@substrat-run/docs': patch
---

A dev server that cannot work refuses to boot, and says what it needs.

`.dev.vars` is this repo's per-project local-env convention — gitignored, written by
`scripts/secrets.mjs dev`, and named as such in `secrets/README.md`. **`wrangler dev` loads
it and `tsx src/server.ts` did not.** The same file, in the same directory, read by one
entry point and silently ignored by the other, with no signal either way: `cf:dev` picked up
your values and `pnpm dev` started without them.

Callout's `server` script now loads it (`node --env-file-if-exists=.dev.vars`), and a new
`preserver` hook checks what that leaves unresolved before the process starts.

**Why a boot failure rather than a prompt.** There is no terminal to prompt at. Claude
Desktop starts these servers from `.claude/launch.json` (`pnpm run server`) with no TTY, so
a `readline` question hangs forever and a warning scrolls past. What an agent *can* read is
a server that died and said why — which is already how this surface signals: `autoPort:
false` is set so a stale port "does not get quietly reassigned, it fails the boot. For an
agent, mid-session" (`tools/launch-emit.mts`). Same mechanism, one more failure mode. The
report names each missing key with its declared label, description and placeholder, and the
exact file to write. Values are never read into the tool or printed — only key names.

**Two declarations, because they answer different questions.** `envSpec[].required` means
required to **deploy**, and is rarely true: a hosted install receives config through
per-scope delivery, so the manifest can honestly call most keys optional. The new
`devServers[].requires` means required to **run this process locally** — the gap the first
cannot express. Locally there is no delivery channel, so `OIDC_ISSUER` absent means broken;
and the harness secrets that actually bite (`PLATFORM_SECRET`, `ROUTER_SECRET`) are
deliberately undeclared in `envSpec` at all. A key named in both gets the spec's prose in
the failure message; a key named only in `requires` is reported bare.

`requires` is deliberately **not** emitted into `launch.json`. A launch file starts a
server; what a server needs in order to start is the `preserver` hook's business, and
duplicating it into a client-specific adapter would make it substance an adapter may not
hold (agent-surface §3).

Callout's `dev` script now calls `pnpm run server` instead of inlining `tsx src/server.ts`,
so the check fires on the human path too — and the command stops being a second copy of the
server invocation. Root `pnpm dev` and `pnpm dev:connected` both funnel through it.

Precedence mirrors the runtime exactly: Node's `--env-file` does not override an already-set
variable, so a shell value wins over `.dev.vars`, which wins over the spec's `default`. The
docs gotcha that used to send you to Desktop's local environment editor now points at
`.dev.vars` instead — Desktop does not inherit your shell, which makes the file the only
route that works in both places.

Callout is wired as the reference; the other demos, the scaffolder template (which needs the
preflight published as a bin), and a generated `.dev.vars.example` are follow-ups.
