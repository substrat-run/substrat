---
'@substrat-run/control-plane-api': patch
'@substrat-run/control-plane-client': patch
'@substrat-run/console': patch
'@substrat-run/dashboard-web': patch
---

A kill switch whose answer was cut short no longer reports "Nothing was switched" (#2010).
When a deployment that has the switch route moved the switch and then lost part of its
answer (a truncated body, or one that failed to read), the control plane said the deployment
predated the route and told the operator to redeploy and retry. Now only a status says a
deployment predates a route: a 404, or a 501 where that deployment's own fallback answers one.
A body never does. An HTML page in particular can't count, because an old deployment's app
page and an error page from something in between look the same. Anything else is a 502 that
says the position is unknown and to read it before retrying. The same rule covers the
switch status reads, the preview-client calls to a team auth server, the cross-vertical event
calls, the plain internal calls, and the carry's fenced wipe.

The console's Schedules and Peers cards and the dashboard's app-to-app panel no longer show
such a failure as "Refused". They read the position again, show it, and say the switch was
not confirmed.

`@substrat-run/control-plane-client` exports `provesNothingChanged(error)`, the one rule both apps
use to tell a refusal (4xx, or 501) from a failure whose effect is unknown.
