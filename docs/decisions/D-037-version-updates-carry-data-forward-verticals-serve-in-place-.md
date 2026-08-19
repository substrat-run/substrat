---
id: D-37
date: 2026-07-27
layer: plan
title: "Version updates carry data forward: verticals serve in place from ONE stable script per…"
status: accepted
aliases: []
twin: K-33   # restates the same decision — collapse candidate
tracking: ["#286"]
---
# D-37 — Version updates carry data forward: verticals serve in place from ONE stable script per…

**Version updates carry data forward: verticals serve in place from ONE stable script per vertical; per-version scripts remain the push archive** ([#286](https://github.com/substrat-run/substrat/issues/286); K-33; supersedes orchestration.md §5.3's serving half). The gap this closes was the live product's sharpest hazard: each version was its own Workers-for-Platforms script with its own DO namespace, so Update rebound a scope to empty storage — data did not follow, and every production deploy was a manual backup→update→restore runbook with post-restore repairs. Now a prod promote re-uploads the promoted bundle onto the vertical's stable serving script (modules read back from the version's archive script, metadata from its retained manifest), DOs and data stay put, and the kernel's append-only migrations finally run against production data as designed. Secrets survive deploys (`keep_bindings`). Safety net: versions badge **code-only vs schema-change** at publish; the scope DO bookmarks (PITR) the instant before an upgrade migrates; a time-boxed, audited **rewind** (24h unless forced) is the first-hours backout, with §8 backup/restore as the considered path. Legacy scopes hop once via **adopt-serving** (export → restore → flip, data-first). Conceded: per-scope staged rollout across versions — illusory for stateful scopes — so blast radius stays per-vertical (D-30)

## Why

The lesson worth the log: §5.3 priced dispatch scripts as stateless when the scope DO *is* the app, and the tell was that the migration machinery the kernel is built around never executed in production — when a design's central mechanism is dead code, the deploy model contradicts the data model. The benefits the old shape claimed (per-scope pinning, rollback by repointing, readiness against the live script) could not coexist with data and so were never actually delivered; the fatal cost was. The backout's honesty is enforced in the DO, not the UI — PITR rewinds the whole database, so a stale bookmark is refused where it cannot be skipped. This also cashes in preview-and-snapshots.md §7's promise that channel-history `at` anchors a PITR rewind: the anchor is now a real bookmark taken at exactly the right instant
