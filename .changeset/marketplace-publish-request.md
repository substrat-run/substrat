---
"@substrat-run/contracts": minor
"@substrat-run/cli": minor
---

**Registry-driven marketplace, phase 3b** (marketplace-publish.md §5) — request-to-publish in
place, so a builder can drive the whole loop.

- `HostAdmin.requestPublish(actor, slug)` — an owner records a pending publish request; sets the
  registry `publish_requested_at` on the vertical (both adapters), audited (`requestPublish` admin
  action). `setVerticalListed` now **clears** the request when staff reviews and lists it, so the
  pending queue drains itself.
- Control-plane endpoint `POST /verticals/:slug/publish-request` — **owner-checked** and on the
  builder allowlist, so an owner asks with a bare slug; staff listing stays the gate.
- CLI `substrat publish <slug>` now *requests* listing ("✓ publish requested … an operator will
  review it") instead of flipping it; `substrat unpublish` is the staff unlist.

The full loop — builder requests → `publishRequestedAt` set → staff lists → `listed` true + request
cleared — is covered end-to-end (contract-suite across both adapters + a control-plane API test).
The dashboard "Request to publish" button + a console pending-requests list are the remaining UX.
