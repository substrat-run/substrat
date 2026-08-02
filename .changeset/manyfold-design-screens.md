---
'@substrat-run/demo-manyfold': minor
'@substrat-run/demo-manyfold-app': minor
---

Manyfold app: finish the remaining design-handover screens (#390).

Everything the "Manyfold CMS design system" handover specified beyond the earlier polish passes,
all bound to real data — no mocked-up states:

- **Field editor modal (screen 9)** — the §4 type grid with every DSL type's column mapping
  (`text→TEXT`, `bool→INT 0/1`, `ref(Type)→ULID`…), a target-type selector for refs, required/index
  toggles with their delivery consequences, and a **Stage change** primary — never "Save".
- **Staged model editor (screen 8)** — edits stage against the live definition: NEW rows tinted
  diff-add, MODIFIED rows tinted review-amber with what changed ("index: true (was false)"),
  removed rows listed with a restore link, drag-to-reorder rows, and the staged-changes banner
  ("N STAGED CHANGES compile to 0002-post-v2 … Discard / Review migration →"). Meta-only edits
  (★ title / ⚑ slug markers, order) count as staged changes too.
- **Migration review, diff-first (11a)** — "Review migration →" shows the generated SQL as an
  add-diff with the backfill step and the never-altered note, PENDING REVIEW badge, the admission
  checklist rail, and per-site "awaiting admission" rows; **Propose for admission** is the actual
  save.
- **Migrations, plan-first (11b)** — per-type CREATE/BACKFILL/CUTOVER steps with expandable
  "view SQL ▾", and per-scope lazy-apply progress rows (applied / cold · applies on next open).
- **Relationship map (10)** — deterministic force layout, curved directed edges with arrowheads
  (double-stroke refMany, dashed assetRef), edge labels, a legend, node selection with
  "Open model →", and pan/zoom contained to the canvas.
- **Reference pickers (4a–4c)** — the modal picker for refMany (search, status filter,
  draft ⚠ / archived ⛓ warnings, create-and-link, reorderable footer chips, "Link N"), the inline
  combobox for single refs (grouped "AUTHORS IN CAFE", match highlighting, create-and-link), and
  the side drawer as the asset-library picker for assetRef fields.
- **Markdown editor** — Write/Preview tabs with a B/I/H2/[link]/`code` toolbar and a
  dependency-free renderer, used in the entry form, the read view, and the delivery preview.
- **Inline validation** — live maxLen errors in the danger pair ("Max 60 characters — currently
  73."), required-field errors on submit, and a slug control with a real uniqueness check against
  the site's entries plus "Re-derive from title". Tags become a chip input, enums a segmented
  control.
- **Delivery preview (6)** — the request bar (GET pill, path, 200, ETag = content hash,
  `cache-control: public, immutable`, FROZEN REV ❄), a rendered resolved payload (blocks list with
  the red dashed unresolved row, author card) beside the raw JSON with `$unresolved` highlighted.
- **Asset library (12)** — grid + selected-tile detail rail with USED BY computed from real entry
  bodies, and upload/replace/delete honestly disabled with reasons until the R2 connector
  (design phase 2).
- **Members & roles (13)** — member table with pending-invite rows (wash background,
  "invite pending · sent 2d ago", Resend/Cancel), and a "Roles are per site" rail showing the
  caller's real role in every site (K-22) plus the role ladder.
