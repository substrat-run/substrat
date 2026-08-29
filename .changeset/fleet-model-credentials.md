---
"@substrat-run/control-plane": patch
---

The fleet's model credentials reach hosted verticals (#1054). The control plane injects `CLOUDFLARE_AI_BASE_URL` / `CLOUDFLARE_AI_API_TOKEN` / `CLOUDFLARE_AI_GATEWAY_ID` onto every pushed vertical at deploy, beside `PLATFORM_SECRET` and `ROUTER_SECRET`, and `scripts/secrets.mjs verticals` re-puts them on already-deployed scripts. Without this there was no path at all: `wrangler secret` cannot reach a dispatch-namespace script, so a desk could pick a model the platform had no credential to run, and every desk answered extractively. Blank keys are skipped rather than failed — a fleet with no model credential stays a supported configuration.
