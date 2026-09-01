---
'@substrat-run/docs': patch
---

The docs site ships a Content Security Policy, and a build that refuses to outgrow it

`vitepress build` now writes `_headers` into the built site, so Cloudflare Pages serves
substrat.net with a CSP plus `X-Frame-Options`, `Permissions-Policy` and HSTS. Nothing was
framing or injecting into a static docs site with no cookies and no user input, so this is
defence in depth rather than a closed hole — `frame-ancestors` is the one directive that
covers something previously unguarded, and the policy is what will bound the ticket0
support widget on the day it goes live.

The script hashes are read back out of the HTML each build just wrote, because VitePress
inlines three scripts per page and one of them embeds a content hash of every page — a
checked-in hash list would be stale the first time anyone edited a page, and stale in the
worst way, since the page still renders but unstyled and stuck in light mode.

The build also refuses to emit a policy the site already violates: add a font from Google
or an analytics snippet and the build fails naming the origin and the directive, instead of
going green and dropping that resource in the browser, on production only.
