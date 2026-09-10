---
'@substrat-run/control-plane-api': patch
---

A masked scope pull no longer exports a person-ish role label verbatim (#1369).

The sweep behind `substrat scope pull --masked` was always table-agnostic — a vertical's
tables, an engine's tables and the `_substrat_*` spine are judged by one column-name
heuristic — but the heuristic had no pattern for the label an engine puts a human's name
in. So `party_label` and `signatory_label`, and the `parties[].label` a fat event payload
spells them as inside `_substrat_outbox.payload` or a platform-request intent, came back
as real production text in a dump whose whole promise is that it holds none.

`<role>_label` now reads as PII and is pseudonymized like every other person field: the
engine's own row and every payload that quoted it agree, and a label holding an email
address comes back as an address rather than as a name. Deliberately narrow — a bare
`label`, `status_label`, `size_label` and the `party_kind` / `party_ref` siblings a
consumer branches and joins on are untouched, because masking those breaks the copy
instead of protecting anyone.

`docs/architecture/preview-and-snapshots.md` §6 now also states what `--masked` reaches,
what a name-based heuristic cannot reach at all, and that the generator's salt is stable
across pulls only when the deployment sets `MASK_SALT` — absent, each export mints a
fresh one.
