---
'@substrat-run/control-plane-api': patch
'@substrat-run/console': patch
'@substrat-run/dashboard-web': patch
---

A kill switch whose answer was cut short no longer reports "Nothing was switched" (#2010).
When a deployment that has the switch route moved the switch and then lost part of its
answer (a truncated body, or one that failed to read), the control plane said the deployment
predated the route and told the operator to redeploy and retry. Now only a 404, the HTML page
an old deployment serves in place of the route, or (where that deployment's own fallback
answers one) a 501 count as "predates". Anything else is a 502 that says the position is
unknown and to read it before retrying. The same rule covers the switch status reads, the
preview-client calls to a team auth server, the cross-vertical event calls, and the plain
internal calls.

The console's Schedules and Peers cards and the dashboard's app-to-app panel no longer show
such a failure as "Refused". They read the position again, show it, and say the switch was
not confirmed.
