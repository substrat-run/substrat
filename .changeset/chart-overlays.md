---
---

An app's traffic chart now shows the facts that explain its shape. Over the same bars you
already read, Observability draws when a migration ran, when a scheduled job failed, how
long an event you expect went missing, and each failure the platform recorded against that
app — a shaded stretch for the missing-event window, a glyph for every instant, with the
releases still drawn as the lines they were. Each glyph is clickable and opens the view
that explains it: the schedule's run history, the log, or the app's schema history. The
overlays are read separately from the traffic, so a chart never waits on them and never
disappears with them.
