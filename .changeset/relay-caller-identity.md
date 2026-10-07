---
'@substrat-run/contracts': minor
---

`relayCaller` and `RELAY_CALLER_HEADER`: who is calling the control plane's relay, as the platform knows it. The egress worker now forwards a deployed vertical's relay calls into the control plane's `RelayGateway` entrypoint with the tenant, scope and vertical the router dispatched, and the email, connection, connect-url and connect-link relays refuse a proven caller that names any scope but its own. Before this, the relay's authentication established that a platform script was calling but not which vertical, so the scope in the request body was taken on the caller's word. Calls that cannot carry a caller yet still pass, until `RELAY_REQUIRE_CALLER` is turned on.
