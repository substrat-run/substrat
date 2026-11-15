---
'@substrat-run/vertical-auth': minor
---

A plugin admits a master app's call made for a person: `resolveOnBehalf` takes a `peer`-channel delegated token minted for this app, and `admitDelegated` admits its person through the person contract with the token's scope as a per-call cap. A master keeps each session's refresh token server-side (`refreshStore`) and obtains such a token with `delegatedToken`. `delegatedToken` keeps the tokens it obtains in the isolate until 30 s before they expire, and forgets a session's refresh token rather than leave a spent one behind when the rotated one cannot be stored.
