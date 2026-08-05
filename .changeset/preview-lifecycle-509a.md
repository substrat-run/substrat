---
'@substrat-run/contracts': minor
'@substrat-run/kernel': minor
'@substrat-run/adapter-sqlite': minor
'@substrat-run/adapter-cloudflare': minor
'@substrat-run/control-plane-api': minor
'@substrat-run/cli': minor
'@substrat-run/dashboard': minor
---

Preview lifecycle fixes — the three self-contained repairs from #509 (issue #512, Tier 1),
turning previews into something you can actually run a workflow on. No design change to the
channel model; that stays for #515.

- **(a) A reused preview no longer silently dies.** `orchestratedPreview`'s reuse branch
  rebound the new version but never touched `expiresAt`, so a `--tag dev` preview CI keeps
  re-pushing to was reaped 72h after its *first* creation regardless of activity. The GC
  deadline is now recomputed on every create — reuse included — via a new narrow
  `HostAdmin.setScopeExpiresAt` (mirroring `setScopeServingRef`; audited on both adapters).
  And `ttlHours` accepts an explicit **`null` = pinned until deliberately deleted**, so a
  long-lived preview environment is expressible at last. `substrat preview create --ttl none`
  pins; re-running a tag renews its TTL.

- **(e) `preview create` stops claiming registry coordinates.** It auto-bumped via
  `nextVersion`, so every PR preview burned a real patch number — the disease that left holes
  in the registry. Previews now push a semver **prerelease** label (`<base>-<tag>.<n>`) via the
  new `previewVersion`: legible (it names the release it rehearses) yet free — `parseSemver` is
  anchored `^\d+\.\d+\.\d+$`, so a prerelease can neither collide with nor advance the coordinate
  the repo owns. An explicit `--version` still wins.

- **(f) The console stops offering promote buttons that do nothing.** `dev`/`staging` are
  write-only (no reader consults them — #509 §2), so the Verticals view now offers only `prod`
  (self-serve for a private vertical, staff-gated for a listed one) and renders no dead channel
  buttons. Read-only history/pills are untouched.
