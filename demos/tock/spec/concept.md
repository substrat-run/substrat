# Tock — concept spec

Status: draft v0.1 · Last updated: 2026-09-09 · For review before any code

> A workspace for turning delivered files into numbers you can stand behind. You declare
> what a file is supposed to contain, Tock tells you what actually arrived, and every
> count it publishes can be traced back to the exact file and the exact rules that
> produced it. Corrections never overwrite: they arrive as a new run beside the old one.
>
> The generic product is *sources, schemas, runs and rollups*. The niche below lives only
> in the seed world.

## 1. What we're building & who uses it

**Fjord Audio** publishes podcasts. Their advertisers pay against download counts, and
those counts come from CDN request logs delivered as daily files. Today someone loads the
files into a spreadsheet, applies a bot list by hand, and mails a number. Nobody can say
six months later which bot list produced March's figure, and when the bot list is updated
the old numbers are quietly replaced.

Tock is where those files land. An analyst uploads a day's log, Tock reads it and reports
what it found, a modeller confirms or corrects the shape, and Tock counts. When the rules
change, you run the day again — the new numbers become current and the old run stays
readable beside them, with the rules it used attached.

**Backlot Media** is a second, unrelated publisher on the same installation. They exist in
this design to be attacked: nothing of Fjord's is reachable from Backlot, and the test
proves it rather than the architecture claiming it.

## 2. The thing that moves through the system

A **run**: one delivered file, taken through to a set of counts.

```
received ──▶ profiled ──▶ mapped ──▶ counted
   │            │            │
   └────────────┴────────────┴──▶ failed
```

- **received** — the file is stored, byte for byte. Nothing has been read. **The stored
  bytes are raw rows**, so reading one back is guarded by the same permission as reading
  raw rows — a source file that anyone could download would be a way around the whole of
  section 4.
- **profiled** — Tock has read it and recorded what fields appeared, how often, what
  types they look like, and what was missing. This is observation, not judgement.
- **mapped** — a person has bound the run to a **schema version**: which field means what,
  which are dimensions, which are measures, what to do with the rest.
- **counted** — the rollups are written, and the run is frozen. Nothing about it changes
  again, including which run is current: **"current" is a query, not a column.** The
  current run for a period is the latest counted one covering it, and that is derived at
  read time rather than stamped on a row that immutability says may not be written.

**Transitions that must not be skippable:**

- You cannot map a run before profiling it. Mapping an unprofiled file is guessing with
  evidence sitting right there unread.
- You cannot count a run before mapping it.
- A **counted run is immutable, and no run is ever deleted.** Not one field. A correction
  is a new run over the same period; counting it makes it the latest, and the earlier run
  is superseded *by consequence* rather than by an update — still stored, still readable,
  still able to answer "what did we report in April, and on what basis".
- **Exactly one run is current per source and period**, and nothing has to enforce that
  under contention: a workspace's operations are serialised, so two corrections counted at
  the same moment are two ordered transactions and the later one simply wins. Each run
  publishes its own rollup rows tagged with its own id, in the transaction that counts it,
  so a report never reads half of one run's numbers beside half of another's.

## 3. What already exists vs. what's yours

**Free from the platform** — not built here, not designed here:

- Two publishers cannot see each other. Isolation is structural, not a filter someone
  remembered to add.
- Every operation checks a permission before it does anything, and the check is recorded.
- Every change writes to a history you can read back per record: who did it, when, and
  what authorised them.
- Schema changes to Tock's own tables are reviewed before they ship, and are append-only
  once shipped.

**Shared components we compose:** none, and that is a deliberate answer rather than an
oversight.

The obvious candidate is the platform's usage-metering component — it already owns an
append-only ledger, de-duplicated intake and immutable period closes, which is most of
section 7 in outline. It is the wrong fit for two specific reasons. Its ledger is one row
per observation with a de-duplication key, which is right for thousands of billable events
and wrong for millions of log lines a day. And a closed period there is a hard floor that
nothing may land behind — which is exactly the operation Tock exists to perform, because
re-running a closed month with a corrected bot list is the normal case here and a
violation there. If a second vertical later wants the same run-and-supersede machinery,
that is the moment to pull it out into something shared. Not before.

**Ours:** sources, schemas, runs, observations, rollups, and the two screens people
actually use — the modelling screen and the report.

## 4. Who is denied what

Four roles. The two answers that must be impossible to miss are at the bottom.

| | read reports | read raw rows *and source files* | run the lifecycle | edit a schema | manage people |
|---|---|---|---|---|---|
| **viewer** | ✅ | ❌ | ❌ | ❌ | ❌ |
| **analyst** | ✅ | ✅ | ✅ | ❌ | ❌ |
| **modeller** | ✅ | ✅ | ✅ | ✅ | ❌ |
| **admin** | ✅ | ✅ | ✅ | ✅ | ✅ |

**"Run the lifecycle" is one permission covering all four steps** — upload, profile, map
and count — and re-running a corrected period is the same permission again, because a
correction is an ordinary run. Splitting them would suggest a workflow where one person
uploads and another counts; there is no such review step here, and a permission that
implies one would be a lie about the design. What is *not* in it is schema editing:
mapping a run **selects** a schema version, and only a modeller can **write** one.

**Who can see the money.** The counts *are* the money — they are what an advertiser is
invoiced against. Every role can read them, including a viewer, because a report nobody
can open is not a report. What separates the roles is who can *change* them: only a
modeller can alter a schema, and only an analyst or above can run a file. A viewer can
read the number and can read which run produced it; they cannot produce a different one.

**Who can see other customers' data.** Two answers, and they are different questions.

*Between publishers:* nobody. Backlot has no role in Fjord's workspace, so every read and
every write there is refused. This is not a role setting anyone can misconfigure.

*Inside a publisher:* the raw rows are the sensitive half. A CDN log line carries an IP
address and a user agent — personal data — and it is the raw rows, not the counts, that
hold them. A **viewer cannot read raw rows at all.** They see the aggregate, which is not
personal data once derived. That is the line the `read raw rows` column exists to draw,
and it is why the role list has four entries rather than three.

Additionally: Tock never stores the raw IP and user agent as themselves. At profiling
they are hashed together with a salt that rotates daily into a **subject key**, which is
what de-duplication compares. The subject key is enough to answer "was this the same
listener twice today" and useless for anything else the next day.

## 5. Money & sign-off

No invoicing, no quotes, no receipts, and nothing gated on a signature. Tock produces the
number that an invoice is written from somewhere else.

One thing worth stating because it is a business risk rather than a technical one:
implementing an industry measurement guideline is not the same as being **certified**
against it, and certification is what an advertiser actually asks for. Tock can implement
the rules and show its working. It cannot claim a certification, and no screen should
imply one.

## 6. The cast, roles, and tenancy

Two publishers, each with one workspace.

| Person | Fjord Audio | Backlot Media |
|---|---|---|
| **Ines Delgado** | admin | — |
| **Tomas Reuter** | analyst | — |
| **Wren Okafor** | viewer | — |
| **Petra Halvorsen** | — | admin |

Petra runs Backlot and is the attacker in the test: she is a legitimate admin of her own
workspace and a nobody in Fjord's.

Sign-in is through a separate identity provider, the same as every other demo here — Tock
holds no passwords and has no way to sign someone in on its own.

## 7. The data we'll store

All tables prefixed `tock_`. This previews the migration review, and these shapes are
append-only once shipped, so this is the cheap moment to argue about them.

- **`tock_source`** — a named stream of files. `key`, `title`, `expected_cadence`,
  `created_at`. "Fjord CDN logs" is one source.
- **`tock_schema`** — one **version** of a source's declared shape. `source_key`,
  `version`, `fields_json`, `created_by`, `created_at`. A save never edits a version; it
  writes the next one. `fields_json` holds, per field: its type, whether it is a dimension,
  a measure or ignored, and whether it is required.
- **`tock_run`** — one file taken through the lifecycle. `id`, `source_key`,
  `schema_version`, `filename`, `byte_size`, `content_hash`, `status`, `period_from`,
  `period_to`, `row_count`, `rejected_count`, `received_at`, `counted_at`, `received_by`.
  The `id` is what "which run produced this number" points at. **No `superseded_by`**: a
  counted run is immutable, so it cannot carry a field that a later run has to write.
  Which run is current for a period is derived — the latest counted one covering it.
- **`tock_rule_state`** — the rules in force for a run, captured when it was counted:
  `run_id`, `rule_kind` (`bot_list`, `threshold`, `dedup_window`, `salt`), `identifier`,
  **`content_hash`**, `captured_at`. This is what makes a superseded run explainable a year
  later; without it the old numbers are preserved and unaccountable, which is barely better
  than losing them. The `content_hash` is the part that actually holds: a bot list called
  "2026-03" can be edited upstream without changing its name, so a name alone records
  which list we *meant* and not which rules we *applied*. A rerun that reproduces the hash
  reproduces the numbers; one that cannot is telling you something true.
- **`tock_salt`** — the daily salt behind `subject_key`: `day`, `salt_id`, `secret`,
  `created_at`, `destroyed_at`. Runs reference the `salt_id` through `tock_rule_state`, so
  a re-run of an old day can say whether it used the same salt or a new one — which decides
  whether its de-duplication is comparable to the original at all. Destroying the secret is
  what makes the subject keys of that day permanently unlinkable, and is the erasure
  mechanism section 9 leans on.
- **`tock_observation`** — what actually arrived, per run per field: `run_id`, `field`,
  `present_count`, `null_count`, `inferred_type`, `distinct_estimate`. Recorded whether or
  not the field is declared.
- **`tock_field_history`** — the same facts rolled up per source and kept **longer than
  the runs themselves**: `source_key`, `field`, `first_seen`, `last_seen`, `day`, `n`. Its
  entire job is to answer questions about March after March's rows are gone, which it
  cannot do if it expires with them. Field names and counts only — never sample values.
- **`tock_source_file`** — the delivered bytes and what identifies them: `run_id`,
  `content_hash`, `byte_size`, `stored_at`, `purge_after`. Reading one back is guarded like
  a raw row, because that is what it contains.
- **`tock_row`** — the mapped rows a run produced. `id`, `run_id`, `occurred_at`,
  `subject_key`, `dims_json`, `metrics_json`. The personal-data table, and the one the
  `read raw rows` permission guards. `subject_key` is the day-salted hash, never a raw
  identifier, and it is erasable — which also means no event may carry it.
- **`tock_rollup`** — the counts. `source_key`, `grain`, `dim_set`, `period_start`, `dim1`,
  `dim2`, `run_id`, `events`, `measure`, `unit` — and **all seven of those are the key**, in
  that order. Two of them are there for reasons worth stating. `source_key`, because without
  it two sources sharing a grain, grouping, dimension pair and period would collide and one
  would silently overwrite the other. And `run_id`, because without it a corrected run
  overwrites the run it displaces — which would quietly delete the earlier number this whole
  design promises stays readable. Ordered so that one source, one grain, one grouping and a
  date range is a key prefix and therefore a single ordered scan; `run_id` sits last so that
  prefix survives, and the report resolves which run is current before it filters. **Two dimension slots is a hard limit, and the schema
  editor enforces it**: a schema declaring a third grouping dimension is refused at save
  time with that reason, rather than accepted and silently unable to group by it. Two
  covers every grouping in section 8 and keeps the key a fixed shape; widening it later
  is a new column and a rebuild, which is cheap precisely because rollups are derived.
  `dim1`/`dim2` are never null — an empty string means "this grouping has no such
  dimension", and a value that was absent in the source row is its own reserved token, so
  the unknown bucket stays a bucket rather than a hole in the primary key.
- **`tock_label`** — the display name for a dimension value, **pinned to the run that
  captured it**: `run_id`, `dim`, `value`, `label`, `captured_at`. The report shows
  "Episode 114 — Harbour Lights", and that string has to come from somewhere. Keying it by
  `run_id` rather than by source is what makes the promise true: a rollup row already names
  its run, so re-reading an old report joins to the labels *that run* captured and shows
  the title as it was. Keyed by source with a timestamp instead, the same report would
  quietly pick up a rename, which is the failure this table exists to prevent.

Two rules the storage enforces rather than merely intends:

- **A measure is never defaulted.** A missing byte count stays empty, and a sum skips it.
  A missing measure turned into a zero is invisible in a total and silently wrong.
- **A dimension that was absent stays absent.** Adding a field to a schema never
  back-fills old rows with a placeholder. An unknown value is reported as unknown — as its
  own bucket in a report, hidden by default and one click from being shown.

## 8. The scenario the test will replay

1. **Provision** both publishers and their workspaces; the four people get their roles.
2. Tomas (analyst) uploads a day of Fjord's CDN log. The run is **received**, then
   **profiled**: seven fields observed, their types inferred, and `campaign` recorded as
   **not present at all** — a fact, not an error.
3. **Denials hold.** Wren (viewer) cannot upload, cannot read raw rows, and cannot edit a
   schema. Tomas cannot edit a schema either — that is the modeller's act.
4. Ines (modeller) declares **schema v1** from the profile, correcting one inferred type
   that was wrong. She maps `episode_id` and `country` as dimensions and `bytes` as a
   measure.
5. The run is **mapped**, then **counted**. Rollups appear; the run is current for its day.
   A report read as Wren returns the same numbers as one read as Ines.
6. **A deviation is caught rather than dropped.** The next day's file carries a new field,
   `client_hint`, that schema v1 does not declare. The run still counts, the field is
   recorded as observed-but-undeclared, and the modelling screen flags it. Nothing is
   silently discarded.
7. **The back-fill affordance tells the truth.** Ines adds `client_hint` to **schema v2**.
   Tock does not ask her for a default; it reports that the field has data from the
   second day and how many earlier rows have none, and offers to re-run from that date or
   leave history as it stands. She leaves it — and the earlier rows stay empty rather than
   acquiring an invented value.
8. **A correction supersedes without destroying.** The bot list is updated and day one is
   uploaded again. A **new run** is profiled, mapped and counted; it becomes current and
   the first run is marked superseded. The report shows the corrected number. The first
   run is still readable, still shows its original number, and still names the bot list
   version it used.
9. **The lifecycle cannot be skipped, and not everyone may drive it.** Mapping an
   unprofiled run fails. Counting an unmapped run fails. Editing a counted run fails.
   Deleting any run fails. And each step is refused for Wren, who holds no lifecycle
   permission — profiling, mapping, counting and re-running a corrected period are all
   denied to her by the same key, asserted step by step rather than inferred from the
   upload denial in step 3. Tomas, who holds it, is denied only the schema write.
10. **Isolation.** Backlot's workspace has no runs and no schemas. Petra, a legitimate
    admin of Backlot, is denied every read and every write in Fjord's workspace — reports
    included.
11. **The two storage rules are asserted, not assumed.** A row missing `bytes` leaves the
    sum unchanged rather than pulling it down; a report grouped by `campaign` over the
    first day shows an unknown bucket rather than a fabricated one.

## 9. Open decisions — each with a default

1. **The name.** `tock` — **settled**, recorded here so the reasoning survives. A tock is
   the completion of an interval, not a heartbeat, and this system does exactly one thing
   per interval: a period's file arrives, is judged, and is counted. Deliberately *not*
   named after counting — the counting is the trivial part, and a name meaning "count"
   would advertise the wrong half and sit too close to the platform's usage metering,
   which section 3 spends a paragraph distinguishing this from. The two existing Tocks
   (a restaurant booking platform, an embedded operating system) are nowhere near this
   sector. **One thing the name must not be allowed to imply:** a clock suggests a live
   heartbeat, and this path is explicitly not one — see the freshness note in section 10.
   No screen should promise real-time.
2. **Where the file is read — and which reading counts.** These are two questions and
   only the first is open. **The browser reads the dropped file to drive the modelling
   conversation**: inferred types, a preview of the rows, the fields it can see. That is
   what makes correcting a guess feel immediate instead of costing a round-trip each time.
   **None of it is authoritative.** The bytes are uploaded, and every number that reaches
   a rollup — the content hash, the row count, the observations, the counts themselves —
   is produced by re-reading those bytes on the server. A design whose entire claim is
   "numbers you can stand behind" cannot take its numbers from the client that submitted
   them; a browser-supplied row count is a claim, not evidence. **Default: this split.**
   The genuinely open part is the preview's ceiling — reading a whole file in the browser
   caps the preview in the low tens of megabytes, and beyond that the preview has to become
   a sample, which makes the inference weaker without making it wrong.
3. **How many workspaces per publisher.** One. **Default: this.** Feed-per-workspace is
   the obvious growth direction and costs nothing to add later; starting there would make
   the first slice bigger for no proof.
4. **Sign-in.** The shared local identity provider every other demo here uses, so the local
   login is the same round-trip as the real one. **Default: this.**
5. **Retention and erasure.** Worth being exact about what personal data actually exists
   here, because it is less than the shape suggests. Raw IP addresses and user agents are
   **never stored**: they are hashed with the day's salt at profiling and only the
   `subject_key` is written. So the rows hold a pseudonymous key plus the dimensions and
   measures a schema declared, and the rollups hold no personal data at all.
   **Defaults:** source files and rows are kept for a bounded window — **90 days**, long
   enough to re-run a quarter's corrections — and the daily salt's secret is destroyed
   after **35 days**, which is past every de-duplication window in use. Destroying the salt
   is the erasure: the subject keys of that day stop being linkable to anyone, including by
   us, and no later re-run can reconstruct them. Rollups are **not** erased and do not need
   to be, because a count is not personal data — which is also why a re-run after the salt
   is gone produces a *different* de-duplication and must say so rather than silently
   differ. An erasure request that names an individual cannot be honoured field-by-field
   here, because the mapping from a person to a subject key is exactly what has been
   destroyed; that limit belongs on screen and in the sales conversation, not in a backlog.
   A legal hold suspends the window, which means someone has to be able to set one — an
   admin act, and the one piece of this that is deferred rather than decided.
6. **Deploy or stay local.** Local. **Default: this.**

## 10. Out of scope, deliberately

Named so the review is about a bounded thing:

- **Any second store.** No object storage, no external query engine, no long-term
  archive. Everything in this document lives in the workspace's own database. This is the
  decision that keeps the first slice small, and the shapes above are chosen so the
  storage can move later without an operation changing.
- **Files arriving on their own.** Someone drops a file. No watched buckets, no schedules,
  no delivery integrations.
- **Distinct counts across arbitrary date ranges.** Counts here are additive, and the
  distinct counting that matters is done by grouping within a fixed day. Sketches and
  merged approximations are a later question, and only if a real requirement appears.
- **Vendored bot lists.** The rules capture *which* list was used. Fetching and updating
  the lists themselves is a later integration.
- **Certification** against any measurement guideline. See section 5.
- **A general query surface.** The report answers a defined set of questions. Arbitrary
  querying by end users is a different product.
- **Anything real-time.** A run is a batch over a delivered period, and the counts it
  produces are as fresh as the last file that arrived — minutes to a day behind, by
  design. "What happened just now" is a different read path over a different store, and
  Tock is not it. The name is a clock and this bullet exists because of that: the
  interval is what ticks over, not the data.

## Review questions

1. **Section 4's raw-row line.** A viewer sees the counts and never the rows, because the
   rows carry IP addresses and the counts do not. Is that the right cut for Fjord — or does
   an advertiser-facing viewer need something narrower still, seeing only their own
   campaign's counts rather than all of them?
2. **Section 7's `tock_rule_state`.** Keeping a superseded run's *numbers* is cheap;
   keeping the *rules* that produced them is the part that makes the old number
   defensible, and it is also the part that will feel like overhead every time a run
   executes. Is "what did we report, and on what basis" a question you actually expect to
   be asked — or are we building an audit trail nobody will open?
3. **Section 9's retention defaults.** 90 days of rows and a salt destroyed at 35 are
   numbers I picked to be defensible, not ones derived from how Fjord actually works. The
   35 has a rule behind it — past every de-duplication window — but the 90 is a guess at
   how far back a correction is ever re-run. If corrections routinely reach further back
   than that, the window is wrong and the design should say so before the first row is
   stored rather than after.
