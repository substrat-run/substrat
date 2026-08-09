---
"@substrat-run/control-plane-api": patch
"@substrat-run/control-plane": patch
---

fix: serve-in-place recovers missing asset bytes from the archive script — promoting an asset-carrying version works (closes #578)

The byteless re-serve at promote bet on the runtime's asset store being deduped
namespace-wide; it dedupes PER SCRIPT, so the stable serving script's upload
session reported every hash missing that the push had just uploaded to the
version's archive script — and every promote of an asset-carrying version 502'd
at the "no bytes" guard, with a remedy (re-push) that could never reach the
stable script's store. A vertical that adopted #340 native assets could never
promote again.

The fix is #578's option 1, symmetric with #286 module recovery: the archive
script is the bundle store for assets exactly as for modules.

- `uploadAssets` (wfp.ts) takes an optional `recoverContent` hook: when a bucket
  wants a hash the upload carries no bytes for, the bytes are fetched back on
  demand and verified against the manifest's content-address before uploading
  under it (D-44: what is trusted is the bytes; what is verified is the key) —
  the fetch is only paid when per-script dedupe actually misses.
- `createControlPlaneApi` gains the host-injected `fetchVerticalAsset` seam (the
  asset twin of `fetchVerticalModules`); `serveVersionInPlace` binds it to the
  promoted version's archive ref.
- The control-plane worker implements the seam over the `DISPATCH` binding —
  assets are served by the runtime's edge without invoking the worker, so a
  plain dispatch fetch of the path returns the bytes (redirects from
  `html_handling` followed by hand, against the same script).
- The "no bytes" refusal now says what recovery attempted and keeps the re-push
  remedy only because it is now real: a fresh push mints a fresh archive script
  the next promote recovers from.
