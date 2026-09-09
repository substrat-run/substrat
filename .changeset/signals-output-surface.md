---
'@substrat-run/contracts': minor
'@substrat-run/cli': minor
'@substrat-run/control-plane-api': minor
'@substrat-run/dashboard': patch
---

A pushed version carries what each operation declares it RETURNS (#1321). The
deploy manifest gains `outputSurface` — operation id plus the field names of its
200/201 response body, derived by the CLI from the emitted `openapi.json` that
`pnpm lint:api` already gates. A paged read contributes its ENTRY's fields, not
the envelope's: the transport's `entries`/`nextCursor` are not the vertical's
surface.

This is the fact the platform could not reach. `openapi.json` is built inside
each vertical and never sent, so the control plane held every declared entity
field (via `model`) and no way to know which of them anything is capable of
returning — the question a field-coverage view has to answer before "is it ever
read" is even worth asking. It rides the existing version-model read, since the
manifest is already parsed there and the field sits beside the model.

Field NAMES, not schemas: the question is reachability, and carrying the shapes
again would duplicate `model` at several times the size. Absent for a vertical
that emits no `openapi.json`, and a malformed one is skipped rather than
refusing the push — an observability surface must never cost a release.
