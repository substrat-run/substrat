---
'@substrat-run/dashboard-web': patch
'@substrat-run/console': patch
'@substrat-run/ui': patch
---

Move the running build version from the sidebar footer into Settings.

The `v0.0.0 · <sha>` build stamp (#346) now lives under an **About** tab in Settings rather
than as a muted footer caption. The dashboard already had a Settings page, so it gains the
tab alongside Profile / Organization / Danger zone. The console had no Settings page, so it
gains one: a new **Settings** nav item (under a "Console" section) opening a tabbed page
whose first tab is About — built as a tabbed page so console-level settings have room to
grow. Both footers drop back to just the identity/account row. A `sliders` icon was added to
the shared `@substrat-run/ui` icon set for the console's Settings nav item (the `cog` was
already the Permissions icon).
