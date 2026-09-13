---
'@substrat-run/control-plane-api': minor
---

An app's logs can now be read for an exact window rather than only the last few hours, and
the Observability chart's time axis became a cursor for it. Click a bar, or one of the
glyphs drawn over the chart, and the Logs and Events panels below narrow to the minutes
around that instant — the chart shades the window it is showing, a chip in the header says
which minutes those are, and the link in your address bar carries them, so a chart you
share opens on the minute that was worth sharing instead of on whatever happened since.
Clearing the cursor puts the panels back on the page's own time range.
