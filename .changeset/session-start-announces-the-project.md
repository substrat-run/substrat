---
'create-substrat': minor
---

A scaffolded vertical now announces itself to an agent at session start, and pins
the docs it should read to the kernel version actually installed.

The smooth part of a framework's agent integration is that the user never has to
remember the framework *has* one. `.substrat/hooks/session-start.mjs` runs when an
agent session opens and hands it what it would otherwise have to discover: that this
is a Substrat vertical, that the always-on rules are in `AGENTS.md` and the build
flow in `.substrat/playbook.md`, and — the reason this exists — the URL of the docs
slice describing **this project's** kernel.

Substrat is 0.x and interfaces change without notice, so an agent working from pages
it cached two minors ago is the expensive failure: confident, plausible, wrong.
`llms.txt` is published at a version-pinned URL so the hook can point at the matching
slice, and a 404 there is the mechanical signal that the docs have moved on. The hook
also records which version it last announced, so the session after an upgrade opens
with the kernel jump stated rather than discovered.

The script lives in `.substrat/` — the tool-neutral home, beside `playbook.md` — and
`.claude/settings.json` is a three-line adapter that runs it. Any other client that
grows a session hook binds the same way.

It is silent unless `package.json` has a `substrat` block (the same block
`substrat push` reads — no sentinel file to invent), makes no network request, and
never fails a session: any unexpected error exits quietly. Opt out entirely with
`.substrat/no-session-context`.
