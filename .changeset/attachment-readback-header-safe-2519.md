---
"@substrat-run/vertical-host": patch
"@substrat-run/control-plane-api": patch
---

A stored attachment can always be read back through the connector attachment route (#2519). A filename with a character outside Latin-1 (an en dash, an accented capital, an emoji) or a content type a header refuses made the route throw, so a file both upload routes had accepted could not be read by a connector. The record header is now printable ASCII (non-ASCII characters are `\uXXXX` escapes in the same JSON, so a client that predates this change parses it unchanged), and the response's own `content-type` falls back to `application/octet-stream` when the stored type is not header-safe. The client reads the content type from the record, which carries the stored value exactly.
