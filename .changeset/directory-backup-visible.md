---
"@substrat-run/console": patch
"@substrat-run/docs": patch
---

feat(console,docs): make the directory backup observable (#40)

The mechanism landed with no way to ask whether it is working, and a backup nobody has
looked at is a belief rather than a guarantee — a cron cannot raise an alarm about its own
absence.

**Console → Settings → Recovery.** Freshness of the newest copy (Current / Late / Stale
against the daily cadence), how many are held, total size, the copies themselves, and a
**Back up now** button for the pre-migration checkpoint. An unbound store renders as the
alarm it is — *this control plane keeps no copy of its own directory* — which is why the
route answers 501 rather than an empty list: "nothing held" and "nobody is looking" must
not read alike. An overdue copy points at the sweep rather than the backup, and says so,
because the cadence guard catches a missed tick up on the very next pass.

Deliberately **no Restore button.** Replacing the directory has a blast radius of every
tenant at once — past what a type-to-confirm dialog can carry — and the disaster it answers
is one where the directory is *gone*, so a recovery path that assumes a working console is
not there when it is needed. Restore stays a deliberate API call from the runbook, and the
panel links to it rather than performing it.

**Docs:** a *Backup and recovery* section on the control-plane page — which failure each
instrument covers (PITR for scope data, the reap copy for teardown, snapshots for a
non-destructive copy, and the directory backup for the map itself), RPO/RTO, the rehearsed
restore, and the honest limits (survives losing the directory, not the account; does not
bring back the D1 staff roster, worker secrets, or sealing keys). `concepts/snapshots.md`
already drew the "not backup/PITR" line, so it now points onward from exactly where a
reader arrives with the question. Self-hosters get the note that matters most to them: on
SQLite there is no PITR underneath, so this pair is not a second line of defence but the
only one.

The control-plane dev server binds an in-memory directory-backup store, so the Recovery tab
is drivable locally.
