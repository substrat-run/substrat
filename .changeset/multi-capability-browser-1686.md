---
'@substrat-run/vertical-host': minor
---

One browser can now hold several link shares at once. Before, opening a second link replaced the first.

Each exchange sets its own cookie, `sb_capability_<capabilityId>`, with the same `HttpOnly`, `SameSite=Lax`, `Path=/` and `Secure` attributes as before. A page that holds several links names the one a call acts as with the `capabilityId` the exchange returned. It goes in the `X-Substrat-Capability` header (`CAPABILITY_HEADER`), or in `?capability=<id>` on a plain link such as a download. `linkShareStub`, `linkShareAttachments` and `mountLinkShareDownload` all use that selection, and a capability still wins over a signed-in visitor.

- A request naming a link the browser doesn't hold is refused as `unauthenticated`, the same as a revoked link. It never falls back to another link or to the signed-in visitor. The session behind a name always acts as its own capability, so a link to one entity can't act on another.
- A request naming no link acts as the most recently opened one, as the single cookie did. A `sb_capability` cookie set before this release keeps working until it expires. The next exchange deletes it.
- A browser holds at most `CAPABILITY_SESSIONS_MAX` (8) links. Opening one more evicts the one exchanged longest ago.
- `clearCapabilitySession(c, { capabilityId })` forgets one link and keeps the others. With no link named, it forgets them all. A string second argument is still read as the cookie name.
- New exports: `capabilitySessionsOf`, `namedCapabilityOf`, `CAPABILITY_HEADER`, `CAPABILITY_QUERY` and `CAPABILITY_SESSIONS_MAX`.
