---
'@substrat-run/dashboard': patch
---

Env tab: a saved setting reports its delivery honestly instead of a silent no-op

Saving a deployment setting already delivered it live to the running app
(`configureInstance` → the vertical's `/internal/configure`), but the Env-tab PUT
swallowed every delivery failure in an empty `catch {}` and returned `delivered: false`
with no explanation — while the UI claimed the value "applies on the app's next deploy."
A save to a vertical with no `/internal/configure` route (its 501), or with no bound
version, was indistinguishable from success — the "no error anywhere, on either side" of
issue #374.

Now the PUT mirrors the sibling auth save: on a delivery failure it returns a readable
`note` (the 501 case names what to fix — add `/internal/configure` support, bind a
version), and the Env tab surfaces `delivered`/`note` so a save that could not reach the
app says so rather than pretending it applied. The banner is corrected too: delivery is
live per-scope config read at runtime, not a next-deploy binding — env-spec `default:`
values ride as worker bindings shared across every install, so a per-install override can
only reach the app through the per-scope channel.
