---
"@substrat-run/vertical-host": patch
"@substrat-run/control-plane-api": patch
"@substrat-run/contracts": minor
"@substrat-run/kernel": minor
---

A stored attachment can always be read back through the connector attachment route (#2519). A filename with a character outside Latin-1 (an en dash, an accented capital, an emoji) or a content type a header refuses made the route throw, so a file both upload routes had accepted could not be read by a connector. The record header is now printable ASCII (non-ASCII characters are `\uXXXX` escapes in the same JSON, so a client that predates this change parses it unchanged), and the response's own `content-type` falls back to `application/octet-stream` when the stored type is not header-safe. The client reads the content type from the record, which carries the stored value exactly.

**New refusals, at every door that stores an attachment.** An upload is now judged by one schema, `attachmentUploadFields` (with its bounds in `ATTACHMENT_FIELD_MAX`, both in `@substrat-run/contracts`), and refused before a byte is written when its filename is over 512 UTF-16 units, its content type over 255, its entity type over 128, its entity id over 255 or its creator over 128. The connector upload routes (multipart and streamed) answer 400 naming the field. These bounds keep the record a read-back carries under 8.2 KiB; a 400-character path still stores. `attachmentRecord` itself is not bounded, so a row stored before these bounds still parses and reads back.

A record already stored with a filename long enough to push the read-back header past 10 KiB is read back with the filename cut to fit and ending in `…`; the bytes, size, sha256 and every other field are exact. Nothing stored is rewritten.
