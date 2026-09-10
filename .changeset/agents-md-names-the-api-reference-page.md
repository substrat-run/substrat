---
'create-substrat': patch
---

The scaffolded project's `AGENTS.md` now says where the API reference is and how to get
there. A launch entry declares a **port**, never a path, so a browser pane opens the bare
origin and no configuration can deep-link a page beneath it — an agent has to navigate
after the preview is up. It now knows to do that by default, and that the page to open on
a vertical serving the Scalar reference is `/api/docs`, same-origin, so a try-it request
runs as the principal already signed in.
