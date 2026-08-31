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
reservation is what keeps a tenant's own label from colliding with one. Behaviour is
unchanged at every site.
