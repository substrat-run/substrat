---
"@substrat-run/console": minor
---

feat(console): bound scopes get bulk selection — move installs to another lineage and retire in one pass

The vertical detail's bound-scopes list gains checkboxes with two bulk actions.
**Move to vertical…** is the #389 update-rebind from the console: every selected
non-fork scope rebinds onto the target lineage's serving script (data first,
source kept as the backout), with the migration-digest acknowledgement surfaced
as a checkbox and any refusal shown verbatim — the CLI stops being the only way
to retire a lineage in favour of another. **Retire…** is the single-scope retire
at selection scale (unbind hostnames → archive → reap; forks hard-deleted),
armed by typing the count like the fleet view's destructive bulk actions. The
fleet view's indeterminate SelectBox moves to a shared console component.
