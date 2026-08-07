---
"@substrat-run/control-plane-api": minor
"@substrat-run/adapter-cloudflare": minor
"@substrat-run/adapter-sqlite": minor
"@substrat-run/contracts": minor
"@substrat-run/kernel": minor
---

feat(platform): the access log drains to Tier 2, and the retention window finally closes (#36)

`_substrat_access_log` shipped with a `drained_at` column, a `pruneAccessLog` that deletes
only drained rows, and an honest note that neither did anything: *"Until the Tier-2 sink
exists, the window **is** the retention."* Nothing ever set `drained_at`, so the prune was
a working function over an empty set and the log grew forever. This builds the missing
half.

**The order is the design.** `sweepAccessLog` (kernel) runs one cycle per platform sweep:
read the oldest undrained rows → **ship** them and let the sink confirm durability → only
**then** stamp `drained_at` → prune. Stamping before a confirmed shipment would turn one
failed upload into permanently deleted evidence, which is the failure K-21 rejected for
tuples. A throw anywhere leaves every row where it was; the shipment is idempotent by key
and the stamp by its `IS NULL` guard, so a tick that dies mid-cycle retries cleanly, and a
tick that died *between* stamp and prune self-heals — the prune is independent of what the
current pass shipped.

**Tier 2 is a seam, not a vendor.** `AccessLogSink` is a kernel interface; the control
plane binds `createR2AccessLogSink`, which writes NDJSON — one row per line — to
`access-log/<firstId>-<lastId>.ndjson`. The key is the batch's id range, which is also its
time range (ULIDs sort chronologically), so *"which object covers March"* needs no
manifest. NDJSON because a truncated object still parses to its last newline, and because
a line format is what a SIEM, a compliance-automation platform and a human with `jq` all
already read — #36's argument against coupling the platform's retention policy to one
vendor's connector roadmap.

It rides the existing directory-backup bucket rather than a binding of its own: the record
is the platform's, not a tenant's, `access-log/` cannot collide with `directory/`, and a
fourth bucket would be one more thing to provision for no isolation gained.

New on `HostAdmin`, implemented by **both** adapters: `markAccessLogDrained(actor, upToId,
drainedAt)` and an `AccessLogFilter.drained` narrowing, so the drain runs over the audited
`accessLog` seam rather than a private read path into the table. The egress is itself
evidence — a new `drainAccessLog` admin action records how many rows left and where they
landed, so a question about a pruned range is answerable from the permanent log and not
only from the object store.

**Opt-in, like every other destructive sweep.** A deployment that binds no sink drains
nothing, prunes nothing, and its window stays unbounded — still a stated limitation, but
now one an operator chooses by not configuring a target, matching the posture of
`SCOPE_RETENTION_DAYS` and `TENANT_RETENTION_DAYS`. The sweep reports `accessLog: null`
in that case rather than zeros: "ships nothing by design" and "shipped, nothing waiting"
are different facts.

The **admin log is untouched and still never swept.** It is the compliance witness; the two
logs have different retention because they are different things, which is why they were
two tables to begin with.
