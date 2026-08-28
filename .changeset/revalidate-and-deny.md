---
"@substrat-run/ui": minor
---

`useAutoRefresh` states the revalidate-and-deny contract and returns an explicit `revalidate()` (#801).

A permission-centric app has a client-side failure of its own: **the screen outlives the
grant.** Nothing leaks — the server refuses every subsequent action — but a person removed
from a list while their browser sits on it keeps seeing it, for as long as nothing refetches.
The hook is now the "re-ask" half of that, and its header names the other half a vertical's
`load()` keeps: route a 403 into the deny state and clear the content it just refused, so the
wall replaces the data instead of sitting above it; and wire a click on the already-selected
nav item to `revalidate()` rather than leaving it a no-op same-route link. The scheduling
moved to a DOM-free `startAutoRefresh` (also exported) so the contract has a test:
nothing while hidden, one refresh per tab return, a slow poll, rejections swallowed,
everything gone on stop.

`demos/todo/app` and `demos/shop/app` adopt it — todo's `ListView` re-walks the same page
depth on revalidation and drops the list when the answer is 403; shop's tabs refetch on a
click on the open tab.
