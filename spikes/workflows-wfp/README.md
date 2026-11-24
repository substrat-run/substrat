# Workflows in Workers for Platforms spike

Evidence for [#3369](https://github.com/substrat-run/substrat/issues/3369): whether Cloudflare
Workflows stays the process engine's default under the rule in
[one-model-for-shipped-code.md](../../docs/rfc/one-model-for-shipped-code.md) §8 (phase 1). It covers
binding, waking, a promote with instances in flight, a preview, and cost. Read
[FINDINGS.md](FINDINGS.md) first.

This is not a workspace member, and nothing here is imported by a package. The lockfile in this
directory is its own.

| File | What it is |
| --- | --- |
| `src/vertical.mjs` | A toy vertical. A scope Durable Object with an outbox, an idempotency record and a copy flag. A Workflow whose steps are scope operations. Its own routes |
| `src/entry.mjs` | The platform entry's shape: everything re-exported, only `fetch` wrapped, each pass counted |
| `harness.mjs`, `scenarios.mjs` | The report lines, the client and the waits, and the questions both runs ask |
| `run-local.mjs` | The questions on local workerd, plus three that need a restart: one workflow name on two scripts, a promote, and an instance held on its version |
| `probe.mjs` | The same questions against a deployed copy, one phase per runbook step |
| `wrangler*.jsonc`, `dispatcher/`, `outbound/` | The stable, preview and clashing scripts, and the dispatcher and outbound worker in front of them |

## Run locally

```
pnpm install --ignore-workspace
node run-local.mjs
```

It prints `PASS`, `FAIL` and `SEEN` lines. **A FAIL is a finding, not a broken harness.** Expect 12
PASS and 6 FAIL. A `harness error` (exit 2) is a broken harness.

## Run on a real dispatch namespace

[RUNBOOK.md](RUNBOOK.md). A person runs it with a Cloudflare credential on a test account. Nothing in
this directory runs it for them, and nothing here was deployed.
