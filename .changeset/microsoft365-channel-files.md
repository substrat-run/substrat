---
'@substrat-run/connector-microsoft365': patch
'@substrat-run/contracts': patch
'@substrat-run/control-plane-api': patch
'@substrat-run/control-plane-client': patch
'@substrat-run/cli': patch
'@substrat-run/docs': patch
---

A Microsoft 365 connection can read and write files in one Teams channel's folder of the tenant's SharePoint site (#2101).

`@substrat-run/connector-microsoft365`: `bindMicrosoft365Scope` binds a scope to one folder, named by its drive path under the site's default document library and held by its item id from then on. A vertical writes by emitting `microsoft365.channel-files-requested` (`microsoft365FilesRequested`: a `directory` under the folder, up to 20 `files` by attachment id, and a required `conflict` of `replace`, `rename` or `fail`). The dispatch uploads each file, in one request up to 4 MB and by upload session up to 50 MB, and keeps a ledger keyed on the event id so a redelivery does not write a second copy. A `rename` conflict uses a suffix derived from the event, never one Graph picks. `sweepMicrosoft365Files` follows the library's change feed and lands each change in the folder through the binding's operation as the connection (`microsoft365ChannelChange`: `upsert`, `content` and `delete`), with file contents uploaded as attachments on the entity the operation names. A path outside the folder is refused before Graph is called. Items outside the folder are never stored or logged. A deleted folder makes the binding refuse rather than fall back to the library root. `registerMicrosoft365FilesConnector` and `declareMicrosoft365FilesConnector` register the dispatch on a host that runs it, or for routing only on one that does not.

`@substrat-run/control-plane-api`: the connection bindings route takes a `folder` for a Microsoft 365 connection, and only for one. `@substrat-run/contracts`: the binding audit entry carries it. `@substrat-run/control-plane-client`: `ConnectionScopeBindingInput` gains an optional `folder`. `@substrat-run/cli`: `substrat connection bind` takes `--folder`.
