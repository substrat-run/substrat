---
'@substrat-run/console': patch
---

The versions table on a vertical's console page reads newest-first, and pages.
The list is walked from the control plane in the route's default order (ascending
by id — publish order), and the table rendered it verbatim, so the oldest push
sat at the top and the version an operator opened the page to look at was the
last row of the last page. It now renders the walk reversed, and the footer is
the Scopes-view one — "Showing 1–20 of N", "Page 1 of M", Prev/Next — instead of
a Load-more button that only ever grew the window and never said where in the
list you were. The promote picker follows the same order, and the Promote… button
pre-selects the newest admitted version rather than the oldest; with a
newest-first dropdown the old default sat at the very bottom of its own list.
