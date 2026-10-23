---
"@substrat-run/vertical-auth": minor
"@substrat-run/vertical-host": patch
---

Stop writing hash-only member invites, and announce when the accept side stops. `createInvite` (and the identity directory's method of the same name) now requires the `become` capability id the invite's link is, and refuses a missing or empty one before anything is written, so no new hash-only row can be created. Every route in this package and in vertical-host already passed one. A caller that passed `null`, or left the argument out, now fails to compile, and an untyped call throws.

`createLegacyInvite` in `@substrat-run/vertical-auth/member-directory` is the explicit way to write a hash-only row. It exists for test fixtures that cover the rows still pending, takes the directory's SQL handle rather than being a method of the identity directory, and is removed with the legacy branch.

Hash-only invites that are already stored still accept by their hash for now. `claimInvite`'s legacy branch stops admitting in the first vertical-auth release published on or after 2027-01-09, at least 90 days after 2026-10-11, when the last route that wrote a hash-only invite stopped doing so. Before that release, the platform counts the hash-only invites still pending on hosted scopes and withdraws any that remain. An invite that is still outstanding then needs to be sent again. `legacyInviteCount` and the `legacy-invites-pending` log line keep reporting what is left.
