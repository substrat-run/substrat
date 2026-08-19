---
'create-substrat': patch
---

The scaffold ships against the packages we actually publish, and can no longer drift.

`index.js` pinned `^0.71.0` and `^0.4.3` while we shipped 0.75.0 and 0.6.2. On 0.x a
caret locks the minor, so those ranges never drifted forward — every project scaffolded
for four minors got old packages, and the session hook then pointed each one at
`llms-0.71.0.txt`, a docs slice that 404s.

The pins going stale is what hid the real damage. Frozen there, the template kept
testing green against packages nobody runs, while two surfaces moved underneath it:

- **`engine-invoicing`** split document-level provenance from per-line (#328).
  `source_type`/`source_id` used to carry the delivery; now `document_type`/`document_id`
  do, and `source_*` carries `time`/`material` and is nullable. The scenario test still
  asserted the old meaning, and now asserts both levels.
- **`vertical-host`** types `onProvision`/`onDeleteScope` as `Promise<void>`. The worker
  passed the sweeper's roster calls straight through, which return a count — so the
  scaffold did not typecheck. They await and discard now.

Both are additive changes the template simply never followed, and nothing would have
said so: `packages/create-substrat/template` is not a workspace member, so its tests and
typecheck never ran in CI.

The pins are now emitted from each package's own version by `pnpm lint:pins`, checked in
CI, and written by `version-packages` so a bump and its pins land in the same PR. The
tool also asserts the seven runtime packages really do share one version, because
`SUBSTRAT` being a single range for all of them is only correct while that holds.

A gate on the numbers still says nothing about whether the template *compiles* against
them — that needs the scaffold built and tested against published packages, which is a
separate job and not yet in CI.
