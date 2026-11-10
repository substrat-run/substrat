---
'@substrat-run/dev-issuer': minor
'@substrat-run/vertical-auth': minor
'@substrat-run/vertical-host': patch
'create-substrat': minor
'@substrat-run/builder': patch
'@substrat-run/builder-workspace': patch
---

A person a member invite names gets in on a local dev server too: `devMemberInvites` keeps a dev server's invites and admits the invitee by the address the issuer verified, through `devLogin({ admit })`, and mounts the same `/api/member-invites` routes the worker door does (now `mountMemberInvites` in vertical-auth). The template's dev server admits invited people, both entry files show how to name `invites`, and the builder wires them for a model with an invite: its skills say how, and the `member-invites` gate refuses a build that leaves the worker, the dev server or the screen unwired.
