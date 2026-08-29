---
"@substrat-run/model-providers": minor
"@substrat-run/vertical-host": minor
"@substrat-run/control-plane-api": minor
"@substrat-run/contract-tests": patch
"@substrat-run/demo-ticket0": patch
---

Hosted verticals reach Workers AI through a **binding**, not a credential (#1054). A provider row may declare `binding`, meaning it is also reachable through a runtime capability rather than over HTTP with a token; `createModelHost({ aiBinding: env.AI })` supplies it, and the control plane binds `env.AI` on every pushed script. The `cloudflare` row is then runnable with no `CLOUDFLARE_AI_*` set anywhere — nothing on the script to read, leak or rotate, and Workers AI bills the account that owns it. The HTTP transport is unchanged for hosts that have a token (the local builder studio). Also replaces the default model: `@cf/meta/llama-3.1-8b-instruct` was deprecated on 2026-05-30 and fails at runtime; the default is now `@cf/meta/llama-3.1-8b-instruct-fast`.
