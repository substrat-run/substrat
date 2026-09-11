---
'@substrat-run/docs': patch
---

The link to the book's printable edition works again. `/book/read.html` is written after
VitePress has finished building, so the site's client-side router has no route for it —
and it intercepts `.html` links rather than letting the browser fetch them, so clicking
the link on the book's front page rendered a 404 without a request ever leaving the
browser. Pasting the URL always worked, which is why the page itself was never at fault.
