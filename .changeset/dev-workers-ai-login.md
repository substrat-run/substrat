---
'@substrat-run/cli': minor
'@substrat-run/control-plane-client': minor
'@substrat-run/control-plane': patch
'create-substrat': patch
---

`substrat dev` reaches real Workers AI through your `substrat login`: a project with `usesModels` gets a loopback relay over short-lived, workspace-scoped model access, and no Cloudflare token (#3420). The control plane issues that access and files each call on the workspace's model usage ledger; the client gains `issueModelAccess()`; the template's agent rules say so.
