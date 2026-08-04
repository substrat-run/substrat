---
'@substrat-run/dashboard': patch
---

The app Observability tab collapsed any logs-fetch failure into a single blanket
"Logs are unavailable right now." — indistinguishable from a real outage, a
misconfiguration, or a permission gap. It now surfaces the plane's status: `501`
reads as "Log streaming is not configured on this platform.", any other error as
"Logs are unavailable (`<status>`): `<message>`" (the plane returns sanitized bodies,
so the message is safe to show). This is what made a `CF_API_TOKEN` missing
`Workers Observability: Read` — the telemetry query 403 the plane maps to a 500 —
undiagnosable from the UI alone.

Also softens the traffic-panel caption from "sampled, approximate" to "approximate,
sampled at high volume": adaptive sampling only kicks in at volume, so at a few
hundred requests the numbers are exact and the old blanket "sampled" read as wrong.
