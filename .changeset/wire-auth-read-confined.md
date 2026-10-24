---
'@substrat-run/kernel': minor
'@substrat-run/adapter-sqlite': minor
'@substrat-run/adapter-cloudflare': minor
'@substrat-run/contract-tests': minor
---

`HostAdmin.listWireAuth`, the read of the wire-signing capability records (RFC wire-signing §7), is bounded and confined before any reader exists. A read is always one page: `limit` is required, from 1 to `LIST_PAGE_MAX`, and one past it is refused rather than clamped. It names its reach, with no default: one tenant's verticals (`{ tenantId }`, the verticals that tenant owns now) or the whole fleet (`{ fleet: true }`). A record whose vertical no tenant owns, or that the registry does not know, is reached by the fleet alone, and a tenant reach follows the vertical's current owner, resolved when the read runs. `verticalSlug` and `cursor` are 1 to `WIRE_AUTH_FILTER_TEXT_MAX` (256) characters, and no other key is taken. Anything else is `validation_failed`, judged by the new `assertWireAuthFilter` before the read, and on Cloudflare before the call into the directory's object, so a refused read keeps its code and logs no access. It returns a new filter built from the judged fields alone, with the reach first, and that is what crosses the RPC and is logged. A tenant's read is logged against that tenant (`wireAuthAccessTarget`), a fleet read against none. `@substrat-run/contract-tests` holds both adapters to it.
