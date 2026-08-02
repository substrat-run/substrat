---
'@substrat-run/control-plane-api': minor
'@substrat-run/cli': minor
---

Refuse the silent lineage fork (#388). A first push of a registry id that doesn't exist yet, whose product name matches an existing lineage the push could confuse itself with (platform-owned, marketplace-listed, or the acting workspace's own), is now refused with the fix named — package.json `substrat.slug`/`substrat.tenant` decide where a push lands — instead of quietly creating a second same-named vertical whose pushes the existing installs never see. `substrat push --allow-fork` makes a deliberate second lineage explicit. Same-name-under-another-tenant stays allowed (each tenant's namespace is its own), and a builder is never told about a foreign private slug. The CLI also prints a pin-it hint while the slug is derived from the package name (a rename would fork the lineage, #399), and surfaces the control plane's refusal text directly instead of raw JSON.
