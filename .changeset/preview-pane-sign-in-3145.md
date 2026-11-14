---
'@substrat-run/contracts': patch
'@substrat-run/vertical-auth': patch
'@substrat-run/control-plane': patch
'@substrat-run/builder': patch
'@substrat-run/builder-web': patch
---

A seeded preview can be signed into inside the builder studio's preview pane (#3145). The pane's new "Sign in as…" menu lists the preview's people; choosing one has the control plane mint a one-time ticket for the signed-in person, which the frame redeems without rendering any page of the persona issuer. A deployment whose issuer is a persona issuer (`isPersonaIssuer`, a seeded preview and nothing else) now sets its sign-in cookies `SameSite=None; Secure; Partitioned`, so they survive the studio's cross-site frame; every other install keeps `Lax`/`Strict`. A seeded preview picks this up when it is pushed again on the released `vertical-auth`.
