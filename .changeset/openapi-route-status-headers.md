---
'@substrat-run/contracts': minor
---

`buildOpenApiDocument` documents an operation's declared success status (`status: 201`) and its named response headers (`responseHeaders`), takes an optional `security` block (the vertical's session-or-bearer default otherwise), and moves a recursive schema's definitions into `components.schemas` so its `$ref`s resolve.
