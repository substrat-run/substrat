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

- **received** — the file is stored, byte for byte. Nothing has been read.
- **profiled** — Tock has read it and recorded what fields appeared, how often, what
  types they look like, and what was missing. This is observation, not judgement.
- **mapped** — a person has bound the run to a **schema version**: which field means what,
  which are dimensions, which are measures, what to do with the rest.
- **counted** — the rollups are written. The run is now **current** for the period it
  covers, and immutable.

**Transitions that must not be skippable:**

- You cannot map a run before profiling it. Mapping an unprofiled file is guessing with
  evidence sitting right there unread.
- You cannot count a run before mapping it.
- A **counted run is immutable, and no run is ever deleted.** A correction is a new run
  over the same period. When it is counted it becomes current and the previous run is
  marked superseded — still stored, still readable, still able to answer "what did we
  report in April, and on what basis".

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

| | read reports | read raw rows | upload a run | edit a schema | manage people |
|---|---|---|---|---|---|
| **viewer** | ✅ | ❌ | ❌ | ❌ | ❌ |
| **analyst** | ✅ | ✅ | ✅ | ❌ | ❌ |
| **modeller** | ✅ | ✅ | ✅ | ✅ | ❌ |
| **admin** | ✅ | ✅ | ✅ | ✅ | ✅ |

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
  `period_to`, `row_count`, `rejected_count`, `superseded_by`, `received_at`, `counted_at`,
  `received_by`. The `id` is what "which run produced this number" points at.
- **`tock_rule_state`** — the rules in force for a run, captured when it was counted:
  `run_id`, `rule_kind` (`bot_list`, `threshold`, `dedup_window`), `identifier`,
  `captured_at`. This is what makes a superseded run explainable a year later; without it
  the old numbers are preserved and unaccountable, which is barely better than losing them.
- **`tock_observation`** — what actually arrived, per run per field: `run_id`, `field`,
  `present_count`, `null_count`, `inferred_type`, `distinct_estimate`. Recorded whether or
  not the field is declared.
- **`tock_field_history`** — the same facts rolled up per source and kept **longer than
  the runs themselves**: `source_key`, `field`, `first_seen`, `last_seen`, `day`, `n`. Its
  entire job is to answer questions about March after March's rows are gone, which it
  cannot do if it expires with them. Field names and counts only — never sample values.
- **`tock_row`** — the mapped rows a run produced. `id`, `run_id`, `occurred_at`,
  `subject_key`, `dims_json`, `metrics_json`. The personal-data table, and the one the
  `read raw rows` permission guards.
- **`tock_rollup`** — the counts. `period_ts`, `grain`, `dim_set`, `dim1`, `dim2`,
  `run_id`, `events`, `measure`, `unit`. Keyed so that one grain, one grouping and a date
  range is a single ordered scan.
- **`tock_label`** — the display name for a dimension value: `source_key`, `dim`, `value`,
  `label`, `captured_at`. The report shows "Episode 114 — Harbour Lights", and that string
  has to come from somewhere; it is captured at count time, so a report re-read next year
  shows the title as it was, not as it has since been renamed.

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
9. **The lifecycle cannot be skipped.** Mapping an unprofiled run fails. Counting an
   unmapped run fails. Editing a counted run fails. Deleting any run fails.
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
2. **Where the file is read.** The browser reads the dropped file and sends Tock the
   observations plus the rows. **Default: this**, because the inference is a conversation
   with the person dropping the file and a round-trip per guess makes that worse. The cost
   is an upload ceiling in the low tens of megabytes, which is fine for a day of logs and
   not fine for a month.
3. **How many workspaces per publisher.** One. **Default: this.** Feed-per-workspace is
   the obvious growth direction and costs nothing to add later; starting there would make
   the first slice bigger for no proof.
4. **Sign-in.** The shared local identity provider every other demo here uses, so the local
   login is the same round-trip as the real one. **Default: this.**
5. **How long raw rows are kept.** Forever, for now, because the workspace holds one
   publisher's own data and the demo needs the rows to re-run from. **Default: this, with
   the limitation stated on screen** rather than quietly assumed. A real retention window
   is a decision to take when there is a second store to move them to.
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
3. **Section 9's second decision.** Reading the file in the browser makes the modelling
   conversation good and puts a hard ceiling on file size. If the real files are already
   larger than that, the first slice should be built the other way round and the modelling
   screen will be worse for it. Which is it?
