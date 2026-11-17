---
'@substrat-run/contracts': minor
'@substrat-run/control-plane-api': minor
'@substrat-run/boundary-lint': patch
'@substrat-run/control-plane': patch
'@substrat-run/demo-auth-server': patch
---

An Auth Server install can ask the platform to register it for platform-provided social sign-in itself (#1544). Opening its Connections page asks when it holds no relay client or lacks a provider the relay serves, at most once an hour, and a "Set up platform sign-in" button asks on demand and shows what the platform answered. The platform reconciles only the calling install's own scope, and never rotates the secret of an install that says it already holds a client.
