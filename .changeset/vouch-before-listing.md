---
'@substrat-run/control-plane-api': patch
---

An auto-admitted version says so, and the vouch that lists it has a button.

Listing a vertical is the moment other tenants start trusting its code, so
`setVerticalListed` refuses while prod points at a version carrying only the
auto-admission note — no human has read it. The refusal is correct. Everything around
it hid what it wanted:

- `mapError` had no pattern for the message, so the refusal fell through to the generic
  500. The console's List button answered `internal error` — the #828 shape again, a
  throw naming its own fix collapsed into a body that names nothing. It is a 409 now,
  with its text, matched on the same string the contract suite already pins against both
  adapters.
- The console rendered the bare `admission` field, so an auto-admitted version showed a
  green **Admitted** badge. It reads **Auto-admitted · needs a vouch to list** now —
  `effectiveAdmission`, the same disagree-with-the-directory discipline as
  `effectiveStatus`.
- The versions table only rendered its action cell for `pending`, so the staff admit that
  clears the note — the one act that makes a private vertical listable — had no button
  anywhere in the console. A **Vouch** button now appears on exactly the versions where
  `admitVersion` would change something.

Found on `substrat-9yjbbn/auth-server`, which was admitted, promoted, serving, and
unlistable, with no way to learn why or to fix it without a raw REST call.
