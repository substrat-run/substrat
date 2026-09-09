---
'@substrat-run/dashboard': patch
---

Release health stops reading "not visible" as "zero", and stops hiding itself
(follow-up to #1236).

The Update comparison showed **0 req · no traffic** for an app whose vertical
another team publishes. The authority answers an unowned vertical with an empty
list rather than a throw — it narrows its ownership map and short-circuits — so
`.catch()` never saw it and the empty summed to a confident zero. That is the
precise misreading every derivation in this feature was written to refuse, and
it shipped anyway. Ownership is now resolved in the route (the Deployments
tab's own test) and passed to the derivation, so an installed app's traffic
reads as absent. The version pair still renders: the registry is not telemetry,
and "am I behind?" is the half ownership never gated.

Two panels also stopped disappearing. The comparison hid whenever there was no
update, so the common GOOD state — you are current — looked identical to a
broken panel; it now says so, beside the running version. And schema history
hid on an empty answer, but an app always HAS migrations: empty only ever meant
the read failed, which during an upgrade window is exactly the fact worth
seeing. It now carries availability from the server — `available: false` is a fact
about the READ, while an empty list with `available: true` is a fact about the
app, since a module may legitimately register no migrations at all.

Individually each panel's "an empty panel is not information" was defensible.
Together they made a tab that looked like nothing had shipped.
