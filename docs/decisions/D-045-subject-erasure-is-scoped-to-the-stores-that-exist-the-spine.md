---
id: D-45
date: 2026-08-08
layer: plan
title: "Subject erasure is scoped to the stores that exist: the spine is redacted,…"
status: accepted
aliases: []
twin: K-37   # restates the same decision — collapse candidate
tracking: ["#37", "#493", "#40", "#36"]
---
# D-45 — Subject erasure is scoped to the stores that exist: the spine is redacted,…

**Subject erasure is scoped to the stores that exist: the spine is redacted, platform-retained copies are crypto-shredded, and the keys sit in the directory** ([#37](https://github.com/substrat-run/substrat/issues/37); K-37 is the kernel-side twin; implements §5.3's crypto-shredding sentence and answers kernel open question 17's spine half). §5.3 promised "PII tokenized/encrypted per-subject with crypto-shredding for erasure" and the contracts package enforced its precondition totally — `piiClass` requires a `subjectId`, message and all — while `packages/` contained no key store, no shred, and no cipher. Two findings shaped what was actually built. **The lake is not there**: `_substrat_outbox.drained_at` is still dead (K-24 built the Tier-2 sink for the ACCESS log only), so the "immutable lake" §5.3's GDPR sentence is about does not exist, and building the mechanism for it would have been building against an absent store. **The un-deletable copies that DO exist are last week's work** — the reap backup (#493), the stored dumps (#40), the tenant export (#36) — all full-fidelity by deliberate design, and therefore all unreachable by a `DELETE`. So: erase in Tier 1 by redaction (mutable store, ordinary UPDATE, envelope kept), erase in every retained copy by destroying a per-subject key that sealed it on the way out, and let the Tier-2 drain inherit the same seam when it is built. Staff-triggered, audited in both logs, and NOT self-service — a builder forwards the DSAR, the platform executes it and returns a receipt (hosting-and-certification.md §3's shared-responsibility line, "we provide extraction, they define scope")

## Why

The decision worth recording is **where the honesty lives**. This is the second compliance mechanism in a fortnight (#36 was the first) whose value depends less on the code than on the limits published beside it, and the issue said so in advance: *"That's a real Article 17 scenario. Don't promise it."* So five limits ship as documentation, not as backlog — one subject per event, vertical tables untouched, copies already handed out, the PITR window, and a directory restore resurrecting a key. Each is the kind of thing a buyer's auditor finds in year two if we do not say it in month one, and §7.8's lesson is that this field has already trained them to disbelieve the claim. Deferred deliberately: the `onSubjectErased` module hook that would bring a vertical's own tables inside the guarantee — it is a new module-facing contract governed by D-28 from its first line, and it deserves its own issue rather than a corner of this one
