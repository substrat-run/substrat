---
'@substrat-run/dashboard': patch
---

Ask reads tighter (#2283, review of #2598). A tool's answer now goes through its route's published output schema, as the HTTP route sends it, so a field a handler returns and the route does not declare never reaches the model. Identifiers the model hands back (ids, cursors) pass unredacted, so a second page is reachable; only roster and audit fields keep an email address whole, and an app's end user's address is redacted. A cut list drops its page's cursor instead of keeping one that skips what was cut, a list nested in a one-item list is cut instead of being replaced by a preview, and the preview is bounded in bytes on a whole character. A read that fails on the platform's side tells the model, and the person, a fixed sentence; its own message is logged, not shown. The ⌘K panel counts a bare list, and no longer reads a record that carries an `error` field as a failed read.
