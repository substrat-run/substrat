---
"@substrat-run/dashboard": patch
---

fix: Test connection no longer reports success next to the error it just cleared

Clicking Test connection on a connection whose last dispatch had failed produced a screen that
contradicted itself: an **Error** pill and "Last error 10m ago: HTTP 401 from scrive" directly
above **Credential accepted** and the verified account.

Nothing was wrong with the stored state. A successful use clears `last_error` and lifts the row
out of `error` (contract-tested for both adapters), and the probe rides the sanctioned `fetch`, so
it had already repaired the row. The screen was pairing a fresh probe result with the connection
row captured when the *list page* loaded, minutes earlier.

Both inspection routes now answer with the row as read in that same request — `…/activity` on
open, and `…/verify` re-read **after** the probe — and the detail view renders that rather than
the prop it was opened with. Closing the drawer refreshes the card behind it, so a repair made
inside is visible outside. The dev-mock path updates through the same state, so the preview cannot
diverge from the live one.
