---
'@substrat-run/console': minor
---

Give the staff console the marketplace-listing surface (#389 piece 1).

The control plane already had the staff-only `POST /verticals/:slug/listing` flip and
builders already file publish requests (`publishRequestedAt`), but staff had no ergonomics
for either — reviewing the queue meant curl. The Verticals view now shows a **Marketplace**
column (listed / publish-requested-with-date / private) so the pending publish queue is
visible from the list, and the detail card gains a **List / Unlist** action: List is the
primary variant (it widens the audience to every tenant), Unlist is danger. The adapter's
refusal to list while prod points at an auto-admitted version is surfaced verbatim, not
pre-checked client-side.
