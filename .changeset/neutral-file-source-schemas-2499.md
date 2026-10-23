---
"@substrat-run/contracts": minor
"@substrat-run/connector-microsoft365": patch
---

Add the provider-neutral file-source vocabulary to `@substrat-run/contracts` (#2499): `fileSourceChange` (the change a sync lands through a vertical's operation), `fileSourceWriteRequest` (the payload of the event a vertical emits to write files, with its explicit `conflict`), `fileSourceConflict`, `fileSourceUpsertAnswer` and the three caps `FILE_SOURCE_MAX_FILES_PER_WRITE`, `FILE_SOURCE_MAX_FILE_BYTES` and `FILE_SOURCE_MAX_WRITE_BYTES`. A vertical codes against these names and a second file-bearing provider lands on the same words. The Microsoft 365 connector now takes its schemas from contracts and exports them under its existing names (`microsoft365ChannelChange`, `microsoft365FilesRequested`, `MAX_FILES_PER_EVENT`, `MAX_FILE_BYTES`, `MAX_EVENT_BYTES`) as the same schema objects, so nothing about its behaviour, its event type or its payloads changes.
