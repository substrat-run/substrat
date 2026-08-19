---
id: D-53
date: 2026-08-15
layer: plan
title: "A generated vertical's repo is hosted by us as a git bundle in R2, not on GitHub"
status: accepted
aliases: []
tracking: []
source: docs/design/builder-studio.md §13
---

# D-53 — A generated vertical's repo is hosted by us as a git bundle in R2, not on GitHub

> **Ratified 2026-08-19.** Transcribed from docs/design/builder-studio.md §13 during the Phase-2 log
> split, which found this decision built but never written into the log. The text is
> the author's; only the id is new.

**A generated vertical's repo is hosted by us as a git bundle in R2, not on GitHub.** One bare repo per vertical, written only by that vertical's `BuilderAgent` DO, stored under the tenant's namespace. A builder's own GitHub is a one-way export target. *(Correction, post-implementation: R2 has no object versioning — rollback is app-level ULID-keyed bundle history, not a bucket feature.)*

## Why

The code is the customer's and we merely hold it, so code should live where the data lives — a tenant with EU-resident data whose business logic sits in a US SaaS is an inconsistency aimed squarely at the buyer the trust moat targets — and hosting customer repos in our own org would make us custodian of their IP at a scale (thousands of repos) with an offboarding story we would have to invent. The decision is also asymmetrically reversible: bundles → any git host is a `git push`, while our-org → elsewhere means transferring repos we should never have held.
