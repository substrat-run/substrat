---
"@substrat-run/adapter-cloudflare": patch
"@substrat-run/adapter-sqlite": patch
"@substrat-run/control-plane-api": patch
"@substrat-run/contract-tests": patch
---

fix(previews): route a preview to its bound version, not the prod serving script (#527)

A preview reported success and printed a URL that then served the promoted **prod**
build, not the version it just pushed — so a reviewer saw their change missing and
concluded it hadn't landed. Root cause: every scope inherited the vertical's stable
`serving_ref` at provision (#286), and routing resolves
`COALESCE(scope.serving_ref, version.deployment_ref)`, so a preview resolved to the
prod serving script instead of the per-version dispatch script its data was restored
into. Preview scopes now skip that inheritance (both adapters), so routing falls through
to the bound version's script. Reused previews created before this fix self-heal (the
stale `serving_ref` is cleared on re-push). Defense-in-depth: `orchestratedPreview` now
refuses to report success for a preview that would route away from its bound version.
