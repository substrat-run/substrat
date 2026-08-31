---
'@substrat-run/contracts': minor
'@substrat-run/control-plane-api': patch
'@substrat-run/cli': patch
---

One hostname module. `parseHostname`, `withLabel`, `isPlatformHost`,
`parsePlatformBaseDomains`, `RESERVED_LABEL_SEPARATOR` and
`DEFAULT_PLATFORM_BASE_DOMAIN` now live in `@substrat-run/contracts`, and the seven
sites that each restated `host.split('.')` and their own idea of "a platform host"
call them instead. Both were load-bearing guards, not conveniences: the first-label
convention is what makes a derived name a sibling in the same zone, and the `--`
reservation is what keeps a tenant's own label from colliding with one.

Behaviour is unchanged at the six call sites that only restated the parse. The seventh
changes, deliberately: a **preview mint** off a base hostname with no dot used to build
`<label>--<tag>.` and bind that, and now returns a 400 saying the hostname is not one a
preview can be minted beside. Deriving a name from something that is not a hostname was
never a success. For the same reason, the four sites that guarded with
`hostname.includes('.')` now guard on the parse itself — `.example.com` and a bare `.`
both pass an `includes` check and are both rejected by `parseHostname`.
