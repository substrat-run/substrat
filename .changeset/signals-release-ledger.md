---
'@substrat-run/dashboard': minor
---

The release ledger (#1236, first cut): a Releases panel on the vertical's
dashboard page — every version with its push instant, prod go-live moment,
where it runs (prod / serve-pending / scopes pinned to it / scopes following
prod), failures from the 90-day record, and 24-hour traffic with its error
count. "Did this push break anything" and "is anyone still on the broken one"
become one table. Nothing is newly recorded — push instants, channel history,
version pins and the version-stamped health facts all existed; this is the
join that did not. An unconfigured metrics plane renders traffic as unknown,
never as zero: "the broken version went quiet" is exactly the misreading that
would invite.
