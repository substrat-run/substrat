---
"@substrat-run/dashboard-web": minor
---

An app's Overview now opens with a "Traffic by status" chart: successful requests in a neutral grey, refused (4xx) in amber and failed (5xx) in red, with a table of requests, errors and latency by surface underneath. Drag across the chart to zoom into a window, which re-reads it in finer bars, or click a bar to pin it and open the logs for exactly that window. Every time chart now marks pushes, go-lives, migrations, failed runs, recorded failures and stale spans the same way, and the overlay chips above a chart hide or show a kind on all of them at once.
