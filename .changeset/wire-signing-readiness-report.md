---
'@substrat-run/contracts': minor
'@substrat-run/kernel': minor
'@substrat-run/control-plane-api': minor
---

The wire-signing readiness report (RFC wire-signing, follow-on 4). `POST /wire-auth/readiness` reads the fleet's capability records and the fleet walk's admin rows, and lists what still blocks three rollout steps: moving an environment to `signed-only`, dropping a public key (when the body names the key, its issuer and `since`, the moment the control plane's list stopped naming it), and withdrawing the shared credential. The report is advisory and read-only. It informs the person taking the step, and no tooling enforces it yet. It calls nothing and writes nothing; its record reads leave their access-log rows. It takes a staff sign-in, and it is paged like the walk: `limit` runs from 1 to 50, and a value outside that is refused.

A script with no record, a held record and an unverified one are listed as unknown, and every gate blocks on them. A record is trusted as current only when it was written after the last applied confirming walk began. When that walk cannot be found whole in the admin log, confirmation is unknown and blocks the move to `signed-only` and every key drop. Every reason is a fixed sentence that names at most a setting or a vertical, never a key, a key id or a tenant.

`@substrat-run/contracts` adds `WIRE_UNSIGNED_ROUTES`, the routes a signer leaves unsigned by design (today `POST /internal/connector-attachment-stream`), each with its method, path and reason, and `wireUnsignedRouteOf`. The report lists each of these routes as a standing blocker of `signed-only`. The control plane's signer counts a streamed call to a listed route as `skipped`, as before. A streamed call to any other route is still sent as given, but is now counted `failed` with the reason `stream-unlisted`. `@substrat-run/kernel` adds the optional `startedAt` to the walk's `WireWalkAudit`, and every `walkWireAuth` row now records when its pass began.
