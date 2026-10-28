---
"@substrat-run/cli": minor
"@substrat-run/contracts": minor
"@substrat-run/control-plane-api": minor
---

Allow application owners to publish a versioned Markdown description with `substrat.concept` in package.json. The CLI includes only the explicitly selected file, bounded to 64 KiB and confined to the application directory. The control plane exposes the published snapshot using the existing owner and listed-application visibility rules.

The dashboard's Ask assistant can query the running application's description by section, with version checks, bounded pagination, and redaction before text is split into pages. Existing releases without a published description remain supported.
