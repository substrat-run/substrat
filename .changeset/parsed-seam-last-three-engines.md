---
'@substrat-run/engine-invoicing': patch
'@substrat-run/engine-metering': patch
'@substrat-run/engine-invites': patch
---

Invites, invoicing and metering now parse the rows they return instead of trusting
a TypeScript assertion that is not there at runtime. Each read names the columns its
published schema describes rather than `SELECT *`, so a column that moved is a throw
naming itself instead of a field quietly missing from a screen — and a column added
upstream never crosses the seam at all. Nothing about the published shapes changed;
what changed is that a stored row which stops matching one is now refused, and blamed
on the engine rather than reported to the caller as a bad request.
