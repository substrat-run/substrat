---
'@substrat-run/contracts': minor
'@substrat-run/kernel': minor
'@substrat-run/adapter-sqlite': minor
'@substrat-run/adapter-cloudflare': minor
'@substrat-run/contract-tests': minor
'@substrat-run/control-plane-api': minor
'@substrat-run/control-plane': minor
'@substrat-run/dashboard-web': patch
---

The fleet walk (RFC wire-signing, follow-on 4): a key listed, rotated, dropped or withdrawn now reaches every deployed script, not only the ones an upload happens to reach. A version's own script, the one a preview is routed to, is uploaded once at its push, and until now nothing rewrote its key lists.

`@substrat-run/control-plane-api` adds `POST /wire-auth/walk`. It brings each script the registry names (each vertical's serving script and every version's own script) to what the control plane's settings give now: both public key lists, the script's own name and `dual`, or none of them. It changes only those four settings, through the runtime's script-settings endpoint (`createWfpWireSettingsApi`, passed as the new `wireSettings` option), without uploading the script again. Every other binding goes back as it was read, and a secret is never read or sent. The walk is run by a person: it takes a staff sign-in, never a service token, and does a dry run unless the body says `apply: true`. Each pass walks at most `limit` scripts and answers the cursor the next one starts from. A script whose record already says it carries what is given is not read, so where the rollout was never set a pass makes no call to the runtime. One script's failure is recorded as an operational failure (`wire-walk`) and the pass goes on. When the read after an update differs, or the served version moved under it, the script is held. Its record carries `walkHold`, naming the bindings that differed, never a value, and later passes leave it alone until a person names it in `release` or an upload of it writes a fresh record. The endpoint has no conditional write, so a change landing between the walk's last read and its write is lost: the walk is not to be run while a push or promote of the same vertical is in flight. `wireUploadGiven` and `wireEntryOf` split `wireUploadFor`, so a walked script and an uploaded one are given the same.

`@substrat-run/contracts` adds the record's optional `walkHold` and the `walkWireAuth` admin action. `@substrat-run/kernel` adds the optional `HostAdmin.recordWireWalk`, which writes one `walkWireAuth` row per pass, and its `WireWalkAudit` entry. A capability record is now written only for a vertical the registry holds: `recordWireAuth` refuses any other slug as `not_found`, in the same directory transaction as the write, so a later registrant of a slug never reads a record of an upload made before it held the slug. Every upload records after its vertical is registered, so this refuses only a write that raced the vertical's delete, and the uploader reports that as its operational failure. Both adapters implement it, and `@substrat-run/contract-tests` holds them to it, a directory restore included. The dashboard's admin log reads the new action as "walked wire auth".
