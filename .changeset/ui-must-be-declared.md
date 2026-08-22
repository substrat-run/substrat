---
'@substrat-run/cli': patch
'create-substrat': patch
---

A UI the push would never serve is refused, and the rule that prevents it moved to where
`app/` is created (#881).

The playbook told the agent to scaffold a UI in Step 7 and to declare it in Step 9, sixty
lines and one **optional** step apart. A build that stopped before deploying therefore
produced a vertical whose `app/` was real, tested, and invisible in production — and the
failure is silent at every gate that runs before it: `pnpm test` never touches `server.ts`,
`boundary-lint` has no opinion about static files, and `substrat push` cannot complain
because a vertical with no UI must legitimately declare no assets.

It reached a live vertical: `training`, a gym app with a full mobile web app under `app/`,
deployed clean and answered 404 at its own hostname. Its `runtimeNeeds` declared `entry`,
`needsNodeCompat`, `stores` and a five-key `envSpec` — no `build`, no `assets` — so
`app/dist` was never built, never uploaded, and `/` fell through to a Hono 404 that looks
exactly like an unbound hostname.

**cli**: `assertUiIsServed` runs before the bundle is built and refuses a push whose UI
nothing would serve, with the `runtimeNeeds.assets` recipe in the message. It fires only
where the UI is provably unreachable — `app/index.html` present, no `assets` in either
vocabulary, and no inlined-assets module under `src/` (the pre-#340 base64 pattern serves
its files from the worker and correctly declares nothing). `--allow-unserved-ui` is the
deliberate override for an `app/` the tree cannot speak for: a mock, a fixture, or one
built and deployed elsewhere.

**create-substrat**: the assets block now lives at the UI-scaffold point in
`.substrat/playbook.md` — *the same change that creates `app/` declares it* — with Step 9
carrying a back-reference instead of a second copy that can drift, plus the two adjacent
failures that are each silent on their own (`runWorkerFirst` missing a worker-owned prefix
answers API calls with `index.html`; an app that bakes a base URL instead of calling its own
origin works on the author's machine and reaches nothing from a phone). Step 9 gains a
verification gate — a deploy is not done until `curl /` returns HTML and `curl /api/me`
returns the worker — and a triage table separating a router 404 from a worker 404. The
same edit is ported into the source skill, and `AGENTS.md` states the rule in one line
because it is the always-on file and the playbook is not.

**Not fixed here, and worth its own issue:** a scaffold freezes `.substrat/playbook.md` at
create time and nothing updates it. `main` being right for months did not help the affected
vertical, whose 310-line copy ends at Step 8, and will not help any vertical already
scaffolded.
