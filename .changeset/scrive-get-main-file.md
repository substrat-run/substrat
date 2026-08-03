---
'@substrat-run/connector-scrive': minor
'@substrat-run/kernel': minor
---

`ScriveApi.getMainFile(documentId)` — pull the sealed signed PDF. The connector
recorded the *fact* of each signature and walked away from the *artifact*: it
could create, set file, set parties, start, and get, but had no
`GET /api/v2/documents/{id}/files/main`, so the signed PDF — Scrive's sealed copy
with the signing evidence attached — lived only at Scrive, reachable only with the
API credential. The legacy CRM this vertical replaces fetches that file on
completion and offers "Ladda ned signerat avtal", so it is parity, not polish
(issue #476, step 1). `ConnectorResponse` gains `arrayBuffer()` for provider
responses that are a file rather than JSON (web `Response` already has it; the
declaration only widens the structural surface). Fetch-on-completion into the
blob store is step 2, which waits on #473.
