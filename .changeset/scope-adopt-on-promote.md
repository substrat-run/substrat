---
'@substrat-run/contracts': minor
'@substrat-run/kernel': minor
'@substrat-run/adapter-sqlite': minor
'@substrat-run/adapter-cloudflare': minor
'@substrat-run/contract-tests': minor
'@substrat-run/control-plane-api': minor
'@substrat-run/cli': minor
---

A prod promote no longer strands a legacy scope's data, and the in-place serve is honest and
complete end-to-end (#321). #287 shipped the serve-in-place, but existing (pre-#286) scopes were
never migrated onto the stable serving script, so every promote re-stranded them: the private-
vertical rebind cascade advanced a legacy scope's version to the incoming version's fresh,
empty per-version dispatch script, `0001-init` re-ran against empty storage, and the app rendered
a no-access page that read as an auth bug rather than data loss.

- **Adopt-before-rebind on promote.** For a dispatch-backed vertical, the host rebind cascade is
  skipped (an embedded vertical, with no per-version script, keeps it) and the control-plane-api
  prod-promote handler owns adopt-then-rebind in the correct order: after a successful in-place
  serve, each still-legacy owned scope is adopted onto the stable serving script — its bytes moved
  off the per-version script *before* any version pointer advances — then rebound. Retry-safe:
  nothing rebinds until the adopt succeeds, so a failed serve strands nothing and a re-promote
  resumes. A shared `adoptScopeOntoServing` primitive backs both this and the explicit endpoint.

- **A builder-triggerable backfill for existing installs.** `substrat scope adopt-serving <scopeId>`
  migrates one legacy scope; `--vertical <slug>` (and `POST /verticals/:slug/adopt-serving`)
  backfills every still-legacy scope of a vertical. Idempotent.

- **`scope restore` accepts an adapter-sqlite scope file and errors actionably.** `importDump`/
  `loadDump` re-assert the kernel spine after the drop-then-replay, so a dump that omits
  `_substrat_roles`/`_substrat_tenant_tuples` (an adapter-sqlite scope file keeps them in its
  directory db) no longer leaves the target missing spine tables and crashing a later check with a
  bare `no such table` → the detail-less `internal error` the field report hit. The restore route
  returns an actionable 422 instead of the generic 500.

- **A failed in-place serve stops reading as "deployed."** `servingVersionId` is added to the
  channel surface (`VerticalChannel` + both adapters' `listChannels`): a prod promote moves the
  channel pointer before the serve, so when the serve fails `servingVersionId !== versionId` is the
  honest signal that the scopes still run the previous code. `substrat versions`, the dashboard
  deployments view, and the console surface the divergence and prompt a re-promote.

- **An empty role projection is a platform condition, not only a per-app 403.** A new
  `GET /tenants/:t/scopes/:s/health` reports `roleProjectionEmpty` for an active scope whose served
  DO has zero projected roles (the silent state the field report chased through a migration-journal
  diff); the console Scopes detail raises it as a flagged condition.

Prevents future stranding and gives a migration path for existing installs. Recovering data already
stranded by an earlier bad promote (locating the specific prior per-version script) is a separate
ops task, out of scope here.
