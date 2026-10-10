---
'@substrat-run/vertical-host': minor
'@substrat-run/control-plane-client': patch
'create-substrat': patch
---

**Deprecated:** a status read from an error's sentence (part of #113). `classifyError`, and with it `mountOperations`, `mountPlatformSurface` and `problemResponse`, still answers a throw that declared no code with 403 for "permission denied", 404 for "not found" or "unknown scope", and 409 for "invalid transition" or "immutable". A later release stops reading the sentence, and such a throw will answer 400 like any other unrecognised one. Until then each match logs `vertical-host.untyped-refusal` in the vertical's own logs, once per sentence, naming the code that keeps the status. Declare it where you throw, with the same sentence: `substratError('not_found', …)` answers the same 404 with the same `detail`, and adds `code`.

No status changes in this release. The scaffold's two missing-record refusals (`customer not found`, `bike not found`) now declare `not_found`. `ControlPlaneClient.assertScopeActive`'s unknown-scope refusal is still a `ControlPlaneError` with status 403, and now also declares `not_found` (new optional `ControlPlaneErrorDetail.code`, surfaced as `ControlPlaneError#code`), so a vertical rethrowing it keeps answering the 404 it answers today. Its `status` and its code disagree (403 against `not_found`) on purpose for this release, so neither reader's answer moves; the gate's other three refusals (unknown tenant, tenant or scope not active) declare no code yet.
