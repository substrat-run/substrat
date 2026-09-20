---
'@substrat-run/adapter-sqlite': minor
'@substrat-run/adapter-cloudflare': minor
---

A directory that is upgraded in place can no longer be left half-upgraded, so an interrupted upgrade cannot lose identity links or the admin log.

Two of the directory's tables change shape on an older store: the external-identity links (their key becomes per-tenant) and the admin log (a platform-level entry may name no tenant). SQLite cannot alter either in place, so each is rebuilt — a new table is filled from the old one, the old one is removed, the new one takes its name — and those steps used to be committed one at a time, on both the self-hosted directory and the hosted one. A stop between removing the old table and renaming the new one left the rows in the scratch table with nothing named after them. The next start then created an empty table of the correct new shape, took it for an upgrade already done, and never looked again: every external identity stopped resolving to a principal, or the audit trail came back empty, and nothing reported an error.

Each rebuild is now a single transaction, so it either finishes or leaves the table exactly as it was — no in-between state exists to be recovered from. A scratch table carried in from underneath, such as a restored backup taken mid-upgrade, is cleared before the copy rather than stopping the directory from opening.

Nothing to change to adopt it. A directory already in the new shape is untouched.
