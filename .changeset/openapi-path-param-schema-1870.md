---
'@substrat-run/contracts': patch
---

`buildOpenApiDocument` now gives a path parameter the schema of the input field it fills, so a `pattern` or `minLength` the field declares appears on the path too (#1870). The mount writes the path value over that field and parses it, so the constraint was already enforced; the document used to say only `string`, and on a read it appeared nowhere. A field that is not a plain string keeps `string`, since a path segment is always text.
