---
'@substrat-run/dashboard': patch
---

Observability is a team-level page now, and it shows the team's own numbers.

It replaces Analytics, which was a preview on estimated figures whose "All apps" selector filtered nothing. In its place: one time axis across every app the team has installed, with a picker for narrowing to one, and totals for requests, errors and the worst latency seen in the window.

The numbers are the team's own. Traffic has always been measured per deployed unit, and one vertical's code serves every team that installed it — so a team that publishes its own vertical was reading fleet-wide figures in answer to a question about its own installation. These are counted per installation.

Each app gets its own row rather than sharing one set of axes, because a busy app and a quiet one on a shared scale turn the quiet one into a flat line at the bottom — usually the one being looked for. An app with no requests at all says so in words instead of drawing an empty row that could be read as either.

And when the figures cannot be read at all, the page says that too, rather than drawing zero. An app that is perfectly busy and an app nobody could ask about look identical as a flat line, and only one of them is a problem with the app.

Old links keep working: the previous Analytics address and the per-app Observability tab both land here, the second already narrowed to that app.
