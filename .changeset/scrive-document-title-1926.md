---
'@substrat-run/engine-protocol': patch
'@substrat-run/connector-scrive': patch
---

A document sent for signing through Scrive is now titled with a name instead of `<templateKey> v<templateVersion>`. The signatory sees that title in the invitation and in Scrive.

- `requestSignatures` accepts an optional `title` for the instance, such as a contract number. `protocol.signatures-requested` carries it as `title`, and when no title is given it carries the template's own title.
- The Scrive connector uses that title for the document and for the attestation sheet it renders when no document is bound. If an event from an older engine has no title, the connector uses the template key. It no longer appends the template version.
- The title is not part of the content hash.
