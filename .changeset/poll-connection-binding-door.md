---
"@substrat-run/contracts": minor
"@substrat-run/kernel": minor
"@substrat-run/adapter-sqlite": patch
"@substrat-run/adapter-cloudflare": minor
"@substrat-run/control-plane-api": minor
"@substrat-run/control-plane-client": minor
"@substrat-run/vertical-host": minor
"@substrat-run/cli": minor
---

Add a staff/service API and `substrat connection bind|bindings` for existing Planima and Fortnox connections. Verify the landing permission in the serving scope before binding, reject copy or mismatched-vertical targets, and audit binding changes. Read hosted connector permissions from the serving deployment rather than the control plane's placeholder scope. This door does not grant new authority or change sweep cadence.
