---
"@substrat-run/builder-workspace": minor
"@substrat-run/builder": patch
"@substrat-run/builder-web": patch
---

The studio's file tree no longer wakes the sandbox container to read.

**Why it was sluggish:** every click in the hosted code pane was a
browser → worker gate → BuilderAgent DO → Sandbox DO → container-bridge round
trip — one per directory level, refetched for every expanded directory after
each turn — and the first click after ~10 idle minutes (the containers-default
`sleepAfter`) blocked on a full container cold start. `GET /api/files` also ran
the restore probe per listing. The CodePane comment claimed reads "never need
the sandbox awake"; hosted reads did.

**Tree snapshots (`snapshotWorkspace`, builder-workspace).** One JSON object of
the vertical's working tree — `git ls-files -c -o --exclude-standard`, so
tracked plus untracked-but-not-ignored, path-normalized across both git modes;
binary/oversize files are listed in `skipped`, never silently dropped. Lives
above the `Workspace` seam so both hosts serve the identical shape.

**Hosted:** the agent writes `projects/<id>/snapshot.json` to R2 right after
the post-commit bundle (best-effort — a failed rebuild never fails the turn),
patches it on studio saves, and serves it whole from R2 via `GET /api/snapshot`
— the container stays asleep. A legacy project builds one lazily from the
container once. **Local:** the same route, built live from disk per request.

**SPA:** one snapshot fetch per refresh; tree expansion and file opens are
instant local operations, saves patch the in-memory copy, and a turn finishing
triggers a single refetch instead of one per expanded directory. Hosts without
a snapshot (pre-first-commit) fall back to the per-directory endpoints, which
are unchanged.

**Worker gate:** membership lookups now go through a 60s per-isolate cache —
the short-TTL trade the gate comment had already named — so file clicks stop
paying a control-plane subrequest each (staff paid it on every `/api/*`
dispatch; non-staff on every request including assets). Revocation lags by at
most the TTL.

The generator's path is deliberately untouched: during a turn the container is
awake by necessity, and the model must read its own uncommitted writes, which a
commit-time snapshot would not have.
