---
'@substrat-run/builder': patch
---

The builder's gates no longer read the `/*` of a route glob in a string (`'/api/auth/*'`) as the start of a comment. They used to skip every line up to the next `*/`, so a dev server that wired its mail outbox right after its sign-in route was refused as writing mail nowhere.
