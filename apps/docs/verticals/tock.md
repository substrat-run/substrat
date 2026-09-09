# Tock (measured file loads)

`demos/tock` — turning delivered files into numbers you can stand behind. You declare what a
file is supposed to contain, Tock reports what actually arrived, and a correction lands as a
new run beside the old one rather than on top of it.

::: warning In progress
Only the **declared model** exists today — entities, operations and permissions in
`spec/model.ts`, with `model.json` emitted from it. There are no handlers, no migrations, no
seed and no app yet, so nothing on this page can be run. The approved design is
[`demos/tock/spec/concept.md`](https://github.com/substrat-run/substrat/blob/main/demos/tock/spec/concept.md).
:::

## Overview

Tock exists for a shape none of the other demos show — **a schema the user edits at runtime,
and data that is allowed to disagree with it**. Manyfold also lets an admin define content
types as data, but it *refuses* at the boundary: a body that does not match its type is
rejected, so nothing can deviate. Tock accepts and records instead, because an archive that
drops an event for carrying an unexpected field has lost the very thing worth knowing.

What it proves:

- **Declared-versus-observed is a first-class answer.** A schema records what was *decided*;
  an observation records what actually *arrived*. Tock stores both, so "this field turned up
  and nobody modelled it" and "this field was declared and has never appeared" are findings
  rather than silences. No tool that samples telemetry can produce the second one — absence
  of evidence is invisible to a sampler — and Substrat can, because the declaration is a fact
  the platform already holds.
- **A correction supersedes without destroying.** Re-running a period with a corrected rule
  writes a **new run**; the earlier one stays stored and readable with the rules it used
  attached. There is deliberately no `superseded_by` column: immutable means not one field,
  so which run is current for a period is *derived* — the latest counted one covering it.
- **Provenance is a column, not a policy.** Every count names the run that produced it, and
  every run names the rules that were in force, by **content hash** rather than by name. A
  bot list called `2026-03` can be edited upstream without its name changing, so a name
  records which list we meant and a hash records which rules we applied.
- **Absence is never a value.** A missing measure stays empty and a sum skips it, because a
  measure defaulted to zero is invisible in a total and silently wrong. A dimension that was
  absent gets its own bucket rather than a fabricated one, and adding a field to a schema
  never back-fills history with a placeholder.
- **The personal data is a hash with an expiry date.** Raw addresses are never stored: they
  are hashed with the day's salt at profiling. Destroying that salt is the erasure, and the
  limit that follows — an individual's request cannot be honoured field by field, because the
  mapping from person to key is exactly what was destroyed — is written into the design
  rather than discovered later.

## At a glance

| | |
|---|---|
| **Package** | `@substrat-run/demo-tock` |
| **Engines composed** | *none* — kernel only. The nearest candidate is [metering](/engines/metering/), and the concept says why it does not fit: a one-row-per-observation ledger is the wrong shape at log volume, and its closed-period floor forbids exactly the re-run this app exists to perform |
| **Own tables** | `tock_sources` · `tock_schemas` · `tock_runs` · `tock_source_files` · `tock_rule_states` · `tock_salts` · `tock_observations` · `tock_field_history` · `tock_rows` · `tock_rollups` · `tock_labels` |
| **Permission surface** | 4 keys — `report:read` · `row:read` · `run:manage` · `schema:manage` |
| **Auth** | [OIDC only](/concepts/identity), like every other demo here |
| **Status** | Model declared; handlers, seed and app not yet built |

## The lifecycle

A **run** is one delivered file taken through to a set of counts.

```
received ──▶ profiled ──▶ mapped ──▶ counted
   │            │            │
   └────────────┴────────────┴──▶ failed
```

Three transitions must not be skippable, and the third is the one that carries the design:

1. **You cannot map a run before profiling it.** Mapping an unread file is guessing with the
   evidence sitting right there unread.
2. **You cannot count a run before mapping it.**
3. **A counted run is immutable and no run is ever deleted.** Not one field.

## Who is denied what

| | read reports | read raw rows *and source files* | run the lifecycle | edit a schema |
|---|---|---|---|---|
| **viewer** | ✅ | ❌ | ❌ | ❌ |
| **analyst** | ✅ | ✅ | ✅ | ❌ |
| **modeller** | ✅ | ✅ | ✅ | ✅ |
| **admin** | ✅ | ✅ | ✅ | ✅ |

The cut worth noticing is the second column, and it covers **two things on purpose**. The raw
rows carry a pseudonymous subject key; the stored source file carries the addresses that key
was derived from. They are the same data in two shapes, so a download guarded by the reporting
permission would be a way around the whole table.

Counts are readable by everyone, including a viewer, because a report nobody can open is not a
report. What separates the roles is who can *change* a number: only a modeller writes a schema
version, and mapping a run merely *selects* one.

## Deliberately out of scope

Any second store — no object storage, no external query engine, no long-term archive;
everything lives in the workspace's own database, and the table shapes are chosen so the
storage can move later without an operation changing. Files arriving on their own, distinct
counts across arbitrary date ranges, vendored rule lists, and a general query surface are all
out too.

And **anything real-time**. A run is a batch over a delivered period, and the counts are as
fresh as the last file that arrived. The name is a clock, which is exactly why that is written
down: the interval is what ticks over, not the data.
