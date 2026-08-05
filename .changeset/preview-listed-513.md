---
'@substrat-run/adapter-cloudflare': minor
'@substrat-run/adapter-sqlite': minor
'@substrat-run/control-plane-api': minor
---

Previews survive publication — a listed vertical's builder keeps a working non-prod path
(#509 ask (d), issue #513, Tier 2).

Before this, the moment a vertical was published (`listed = true`) its builder had **no**
non-prod path at all: the `dev`/`staging` promote buttons served nothing (fixed in #512),
prod promote is staff-gated, and previews were refused outright (`403 — private verticals
only`). Even relaxing that 403 wasn't enough, because `bindScopeVersion` hard-refuses a
non-admitted version, and a listed vertical's push lands **pending** — so the preview could
never bind the new code.

The fix draws the boundary where it belongs. **Admission gates code reaching an install.**
A preview is a fork of the builder's *own* tenant scope at a non-canonical URL, serving no
install — the same own-tenant blast radius a private vertical already self-admits under. So:

- **`bindScopeVersion` admits a pending version onto a `preview` scope** (both adapters), and
  keeps the refusal for every other scope kind. A serving scope still cannot bind unadmitted
  code — the marketplace install gate is intact.
- **The preview gate no longer refuses listed verticals.** A builder is still confined to a
  vertical it owns, and a first-party vertical (no owner tenant) still has no scope of its own
  to fork.

The working non-prod path for a listed vertical is the CLI — `substrat preview create --tag …`
now forks the owner's prod scope and runs the pending PR code on it. (The dashboard has no
preview surface yet; a console affordance is future work.)

Contract-suite coverage (runs against both adapters) asserts a preview fork binds a pending
version while a serving scope still refuses it; the control-plane API test covers the listed
owner end-to-end plus the first-party refusal.
