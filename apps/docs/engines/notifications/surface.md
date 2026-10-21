# Operations & permissions

## Registered operations

| Operation | Permission | Does |
|---|---|---|
| `notifications/my-preferences` | `notifications:self` | The caller's notification address and every topic's switch |
| `notifications/set-my-address` | `notifications:self` | Set or clear where the caller's notifications go |
| `notifications/set-my-preference` | `notifications:self` | Switch one topic on or off for the caller, on one channel, and choose when it arrives |
| `notifications/list-deliveries` | `notifications:read` | What became of each notification, newest first |
| `notifications/my-deliveries` | `notifications:self` | What became of each notification sent to the caller, newest first |
| `notifications/send-digests` | `notifications:send-digests` | Send each person whose digest is due one mail of what was held for it |

Engines declare no HTTP paths. A composing vertical binds operations with
`defineEngineRoutes`. Registered handlers check the permissions above.

## In-scope functions

`notify`, `myPreferencesOf`, `setMyAddress`, `setMyPreference`,
`listDeliveries`, `listMyDeliveries` and `sendDigests` are exported for composition.
The caller checks permissions first; `notify` checks no permission itself.

Both delivery operations return pages, newest first. `my-deliveries` pins the caller's
principal and takes no principal input. Its rows omit the principal, dedupe key and
send-intent id. A reason is shown only for skipped deliveries; platform failure codes
remain in the administrator's log. Filter by topic or status, and by principal on the
administrator's operation.

## Permissions

- `notifications:self` manages the caller's address and topic preferences and reads
  their history.
- `notifications:read` reads the scope's delivery log.
- `notifications:send-digests` belongs to the engine's system principal for its
  15-minute schedule. The manifest declares `holder: 'system'`; no person's role holds it.
