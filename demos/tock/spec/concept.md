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

### One file, several kinds of record

A delivered file rarely holds one shape. An analytics firehose holds page views beside
tracked events beside identifications, each with different fields, told apart by a value in
the record itself. Modelling that as one schema means modelling the union of everything —
a shape where almost every field is absent almost always, and no reader can tell a missing
value from a value that does not apply to this kind of record.

So a source declares its **discriminators**: an ordered list of fields whose values tell
record kinds apart. A **variant** is then identified by a *prefix* of those values.

```
discriminators: [ "type", "event" ]

variant                    selector                    what it adds
──────────────────────────────────────────────────────────────────────────
(every record)             []                          the common envelope
page                       [page]                      —
identify                   [identify]                  —
track                      [track]                     — (its events share nothing)
track / scroll             [track, scroll]             scroll
track / view-article       [track, viewArticle]        itemSrc, name, state, …
```

A record belongs to the **longest** variant whose selector values all hold — and the match
must **consume every discriminator the record actually carries**. `page` stops at one level
because it carries no `event`; a track record carries one and therefore has to reach two.
Nothing special-cases depth, and a third discriminator later is one more value in the list
rather than a new idea.

That second half is the load-bearing part, because without it longest-prefix quietly
swallows the case this whole section exists for. A `track` record carrying an `event` nobody
declared still matches `[track]`, and a rule that stopped at "longest match wins" would file
it under `track` — counted, under a kind whose schema declares nothing, with the new event
name never reported. The shape that arrived would be absorbed into the shape we knew, which
is the failure mode a union schema had and this design replaced. So `[track]` is a
**schema-only prefix**: a level that exists to hold fields its sub-kinds share, and that no
record terminates at while carrying a further discriminator. A variant is **terminal** for a
record only when the record has no discriminator value left to account for.

**Schemas attach to prefixes and stack.** A record's shape is the union along its path —
the envelope, plus what its kind adds, plus what its sub-kind adds. That is what stops the
sixteen envelope fields being declared once per variant, and it makes an *empty* middle
level a readable fact rather than an omission: a stream whose kinds share nothing says so.

**A list of known values is a declaration, not a constraint.** When a value nobody declared
arrives — at any depth — the record is kept, classified as **unmatched** against the deepest
prefix that did hold, and reported as a finding naming the undeclared value and its count. It
is never rejected. The first time a producer ships a new event name, a design that validated
here would lose the data — which is the one thing an archive may not do.

**Ambiguity is refused at save time, not discovered at ingest.** Selectors are exact prefixes
of an ordered list, so a record's values pick out exactly one selector per depth: two
variants that both match a record equally deeply are two variants with the *same* selector,
which is a duplicate declaration and nothing else. That is a uniqueness rule the schema
editor enforces when a variant is saved, refusing the second with the first one named. Left
to ingest it would be unresolvable rather than merely late — a row carries one
`variant_key`, so there is no value to write while the question is open, and a design cannot
report an ambiguity it has nowhere to record.

### The shapes counts are built over

Variants describe what **arrives**, and what arrives drifts: a producer renames a field,
changes a unit, splits one event into two. Counting directly over variants would make every
such change a break in the numbers.

So a source also declares **output schemas** — the stable shapes counts are built over —
and a **mapping** from each variant into one of them. When the input moves, the mapping
moves and the output schema does not. Two variants can share one output: `activeDuration`
and `idleDuration` carry the same two fields and are the same measurement, so they map to
one shape with the event name as a dimension.

**A mapping is data a reviewer can read as a table**, and that bound is the whole of its
design. A field may be renamed, retyped, scaled by a declared factor, or have its values
remapped through a declared list of pairs. Each of those is a *datum*. What a mapping may
never contain is an expression — no arithmetic on other fields, no conditionals, no
functions. The moment it needs a parser it has become a small programming language living
inside a schema editor, and a value that genuinely needs computing belongs in the producer,
where someone can test it.

A mapping names **which version of the output schema it targets**, not merely which output
shape. Output schemas are versioned and additive, so "the shape called `duration`" is not a
single thing over time, and a mapping that named only the key would be explainable in terms
of a shape that has since grown fields it never wrote.

And the output key travels with the numbers. A source declares several output shapes, and
two of them may reasonably use the same measure and dimension names for different things —
so an output key that lived only in the mapping would let two shapes collide in one rollup
row, one silently overwriting the other. That is the same argument `source_key` is in the
rollup key for, one level down, and section 7 carries it into the rows and the rollups
rather than leaving it to the mapping table.

Mappings are versioned like schemas, and which version was in force is captured on the run
beside the other rules — so a corrected number can be explained by the mapping that made it,
not merely by the file it came from.

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
  `discriminators` (the ordered field list, empty for a stream of one shape), `created_at`.
- **`tock_variant`** — one record kind. `source_key`, `key`, `selector` (the ordered prefix
  of discriminator values), `created_at`. A source with no discriminators has exactly one
  variant with an empty selector, which is how a single-shape stream stays the simple case
  rather than a special case. **`(source_key, selector)` is unique**, and that is the
  storage enforcing section 2's rule rather than restating it: two variants with the same
  selector are the only way a record could match two equally deeply, so refusing the
  duplicate at save time is what makes classification total — every record gets exactly one
  `variant_key`, or is unmatched, and never both.
- **`tock_schema`** — one **version** of a declared shape, attached to a *variant* rather
  than to the source as a whole. `source_key`, `variant_key` (empty for the envelope every
  record shares), `version`, `fields_json`, `created_by`, `created_at`. A save never edits a
  version; it writes the next one. `fields_json` holds, per field: its type, whether it is a
  dimension, a measure or ignored, and whether it is required.

  A record's effective shape is the **union along its path** — the envelope, then its kind,
  then its sub-kind. Declaring the envelope once is the point; fourteen variants repeating
  sixteen identical fields would be fourteen places for them to drift apart.
- **`tock_output_schema`** — a stable shape counts are built over. `source_key`, `key`,
  `version`, `fields_json`, `created_at`. Versioned and **additive only**, by the same rule
  the rest of the design runs on: a field never changes meaning, because a field that does
  turns every historical number into a silent lie.
- **`tock_mapping`** — how one variant becomes one output shape. `source_key`,
  `variant_key`, `output_key`, **`output_version`**, `version`, `rules_json`, `created_by`,
  `created_at`. Two versions here, and they are different questions: `version` is this
  mapping's own, `output_version` is the version of `tock_output_schema` it was written
  against. Without the second, a mapping is explainable only in terms of whatever that
  output shape has grown into since.
  `rules_json` is a list of correspondences — source field, output field, and optionally a
  declared type, a numeric scale, or a list of value pairs to remap through.

  **It holds no expressions, and that is the design rather than a limitation.** Every rule
  is a datum a person can read in a table and check against the file. Admit arithmetic and
  you have a programming language inside a schema editor, untested and unversioned against
  anything but itself; a value that needs computing belongs in the producer. The bound is
  what keeps "which mapping produced this number" an answerable question.
- **`tock_run`** — one file taken through the lifecycle. `id`, `source_key`, `filename`,
  `byte_size`, `content_hash`, `status`, `period_from`, `period_to`, `row_count`,
  `rejected_count`, `received_at`, `counted_at`, `received_by`.

  **`schema_version` survives but stops being the answer.** It is a shipped column and
  append-only says it stays, so this is a change of meaning rather than of shape: it is the
  **envelope's** version, the one every record in the file was validated against. What it
  cannot be any more is *the* schema of a run. Schemas attach to prefixes and stack, each
  versioned on its own, so a mixed file's records are validated by the envelope's version
  *plus* their kind's *plus* their sub-kind's, and one file legitimately uses several such
  paths at once. A single column could only ever name one of them, which would leave a
  historical run unreproducible while appearing to record exactly what produced it. The full
  set goes to `tock_rule_state` below, where the rest of "what rules were in force" already
  lives — and a reader who wants the schema of a run looks there, not here.
  The `id` is what "which run produced this number" points at. **No `superseded_by`**: a
  counted run is immutable, so it cannot carry a field that a later run has to write.
  Which run is current for a period is derived — the latest counted one covering it.
- **`tock_rule_state`** — the rules in force for a run, captured when it was counted:
  `run_id`, `rule_kind` (`bot_list`, `threshold`, `dedup_window`, `salt`, `mapping`,
  **`schema`**, **`classification`**), `identifier`,
  **`content_hash`**, `captured_at`.

  The last two are what variants add, and they are the same mechanism rather than new ones.
  A **`schema`** row per prefix the run actually used — `identifier` is the variant path,
  empty for the envelope — is how the set `tock_run.schema_version` can no longer carry gets
  recorded; a run over a mixed file writes several, and a single-shape stream writes one,
  which is the simple case staying simple. A **`classification`** row hashes the
  discriminator order together with the full selector set, because capturing which *mapping*
  ran while leaving out the rules that *chose* it explains half of how a number was made. The
  document permits adding a third discriminator, and adding one silently re-files every
  record; without this row an old run could show its mapping and still not say why a record
  reached that mapping at all.

  **This one is not an additive migration, and saying so is the point of previewing it
  here.** The shipped table is `UNIQUE (run_id, rule_kind)` — one row per kind per run —
  which was right while every kind named a single thing and is wrong the moment `schema`
  names one per prefix. The uniqueness has to become `(run_id, rule_kind, identifier)`, and
  the shipped `CHECK` on `rule_kind` has to admit the new values. Neither is an `ALTER`, so
  both are a table rebuild carrying the existing rows forward — cheap now, because no
  production data exists, and the reason this shape is argued before code rather than after. This is what makes a superseded run explainable a year
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
- **`tock_discriminator_observation`** — the values that tell kinds apart, counted:
  `run_id`, `path` (the parent selector, empty at the top), `field`, `value`, `n`. A
  `distinct_estimate` says *eleven event names appeared* and the modelling screen has to say
  *which eleven, and how many of each* — a modeller confirming discriminators is choosing
  among values, and cannot choose from a count. This is also what lets an undeclared kind be
  reported as a finding naming the value, at any depth: keying by `path` is what separates
  "a `type` nobody listed" from "an `event` nobody listed under `track`", which a flat
  field→value table would flatten into the same row.

  **Values here, and nowhere else.** This is the one table that records observed *values*
  rather than names and counts, and the exception is narrow and deliberate: it holds only
  fields a person has confirmed as discriminators, whose values are record kinds
  (`page`, `track`, `viewArticle`) rather than data about anyone. It is bounded by the same
  judgement — profiling *proposes* discriminators and a person confirms them, so a field of
  eleven thousand request ids never becomes eleven thousand rows here. `tock_field_history`
  keeps its rule unchanged: names and counts, never sample values.
- **`tock_field_history`** — the same facts rolled up per source and kept **longer than
  the runs themselves**: `source_key`, `field`, `first_seen`, `last_seen`, `day`, `n`. Its
  entire job is to answer questions about March after March's rows are gone, which it
  cannot do if it expires with them. Field names and counts only — never sample values.
- **`tock_source_file`** — the delivered bytes and what identifies them: `run_id`,
  `content_hash`, `byte_size`, `stored_at`, `purge_after`. Reading one back is guarded like
  a raw row, because that is what it contains.
- **`tock_row`** — the mapped rows a run produced. `id`, `run_id`, `variant_key` (empty
  when the record matched none — kept and reported, never dropped), **`output_key`** (the
  output shape the mapping produced this row into, empty for an unmatched record, which by
  definition reached no mapping), `occurred_at`, `subject_key`, `dims_json`,
  `metrics_json`. `dims_json` and `metrics_json` are named against the output shape, not the
  variant, so without the key a row does not say which vocabulary its own field names
  belong to. The personal-data table, and the one the
  `read raw rows` permission guards. `subject_key` is the day-salted hash, never a raw
  identifier, and it is erasable — which also means no event may carry it.
- **`tock_rollup`** — the counts. `source_key`, `output_key`, `grain`, `dim_set`,
  `period_start`, `dim1`, `dim2`, `run_id`, `events`, `measure`, `unit` — and **all eight of
  those are the key**, in that order. Three of them are there for reasons worth stating.
  `source_key`, because without it two sources sharing a grain, grouping, dimension pair and
  period would collide and one would silently overwrite the other. **`output_key`, because
  the same is true one level down**: a source declares several output shapes, and two of them
  may use the same measure and dimension names for different measurements, so without it the
  collision `source_key` prevents between sources happens inside one. And `run_id`, because
  without it a corrected run overwrites the run it displaces — which would quietly delete the
  earlier number this whole design promises stays readable. Ordered so that one source, one
  output shape, one grain, one grouping and a date range is a key prefix and therefore a
  single ordered scan; `run_id` sits last so that prefix survives, and the report resolves
  which run is current before it filters. **Two dimension slots is a hard limit, and the schema
  editor enforces it**: a schema declaring a third grouping dimension is refused at save
  time with that reason, rather than accepted and silently unable to group by it. Two
  covers every grouping in section 8 and keeps the key a fixed shape; widening it later
  is a new column and a rebuild, which is cheap precisely because rollups are derived — the
  same rebuild `output_key` costs, and for the same reason it is affordable.
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

### A file of several kinds

These replay the same discipline one level up — what arrives is recorded, what was declared
is separate, and a disagreement between them is a finding rather than a loss.

12. **Profiling proposes the kinds.** A file holding four values of `type`, and eleven
    values of `event` within one of them, is reported as such — each value **named with its
    count**, and the eleven reported *under* the `type` they appeared within rather than as a
    flat list. Nothing is created from that automatically: Ines confirms which fields are
    discriminators, because "these two values are different kinds of record" is a judgement
    about the stream and not a fact in it.
13. **The envelope is declared once.** The sixteen fields every record carries are the
    root schema; a variant declares only what it adds. A variant that adds nothing — a kind
    whose records are pure envelope — is legitimate and says so.
14. **An undeclared kind is kept.** A file arrives carrying a `type` nobody listed. Its
    records are stored, marked unmatched, and reported as a finding naming the value and the
    count. Nothing is rejected, and the count for every declared kind is unaffected.
15. **An undeclared kind is kept at DEPTH too, which is the case that can go silently
    wrong.** The same file carries a `track` record whose `event` nobody listed. `[track]` is
    declared, so longest-prefix alone would file the record under it — counted as an ordinary
    `track`, under a schema that declares nothing, with the new event name never surfacing.
    The test asserts the opposite: the record is unmatched, the finding names
    `track / <the new event>`, and `track`'s own count does not absorb it. A depth-one
    assertion cannot catch this, which is exactly why it is its own step.
16. **A duplicate selector is refused when it is saved.** Declaring a second variant with a
    selector already in use fails at save time, naming the variant that holds it. This is the
    other half of the step above: classification stays total because two variants can never
    match one record equally deeply, and the enforcement is at the schema editor rather than
    at ingest, where a row has one `variant_key` and no way to hold an open question.
17. **Two variants collapse into one output.** `activeDuration` and `idleDuration` carry
    the same two fields and are the same measurement; both map to one output shape with the
    kind as a dimension. The report groups by it and the two are comparable, which they
    would not be as separate shapes.
18. **A renamed input does not move the output.** The producer renames a field. A new
    mapping version says so, the output schema is untouched, and a period re-run under the
    new mapping supersedes the old one — with `tock_rule_state` naming which mapping each
    run used, so the two numbers are explainable side by side rather than merely different.
19. **A run says which rules classified it, not only which mapped it.** The counted run
    carries a `schema` row per prefix it used and one `classification` row hashing the
    discriminator order and selector set. Adding a variant and re-running produces a
    different `classification` hash on the new run and leaves the old one's untouched — so
    "why did this record become that number" is answerable for the superseded run, which is
    the run nobody can re-derive by inspection.
20. **A mapping cannot compute.** Attempting a rule that derives a value from another
    field is refused at save time, naming the reason. The refusal is the feature: a
    computed value belongs in the producer, where it can be tested.

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
- **A transformation language.** A mapping renames, retypes, scales by a declared factor
  and remaps values through a declared list. It holds no expressions, no conditionals and
  no references to other fields, and it never will: that is the line between a reviewable
  table and a programming language nobody tests. Deriving a value is the producer's job.
- **Inferring the kinds.** Profiling *proposes* discriminators and reports the values it
  saw; a person decides which of them mean "a different kind of record". A stream where
  every request id is technically a distinct value would otherwise become a source with
  eleven thousand variants.
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
3. **How much the mapping layer should carry.** Rename, retype, scale and value-remap are
   four capabilities, and each is a place someone will ask for a fifth. Scale exists because
   a unit change (milliseconds to seconds) is the drift I expect most; value-remap because a
   renamed enum is the second. If neither is a real case for Fjord, both should go — every
   capability here is a thing a reviewer has to read and a mapping can get wrong.
4. **Section 9's retention defaults.** 90 days of rows and a salt destroyed at 35 are
   numbers I picked to be defensible, not ones derived from how Fjord actually works. The
   35 has a rule behind it — past every de-duplication window — but the 90 is a guess at
   how far back a correction is ever re-run. If corrections routinely reach further back
   than that, the window is wrong and the design should say so before the first row is
   stored rather than after.
