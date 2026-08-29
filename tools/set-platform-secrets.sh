#!/usr/bin/env bash
#
# REMOVED (#979) — this script is a stub that refuses, and should be deleted.
#
# It set the three shared tokens on the control plane, the dashboard and the router,
# and then only PRINTED "re-push any verticals". That reminder is the whole defect: a
# vertical receives PLATFORM_SECRET/ROUTER_SECRET as bindings baked in at deploy time
# (control-plane-api/src/wfp.ts injectSecrets), so the moment the platform workers hold
# new values and the fleet does not, every hosted app rejects the router's node
# assertion (users locked out) and the control plane's /internal/* calls 403 (Data tab,
# config delivery, provisioning). The 2026-08-01 rotation ran exactly this script,
# stopped exactly here, and took the whole hosted fleet offline.
#
# `scripts/secrets.mjs` already had the missing step and now runs it: `push` re-puts the
# pair on every script in the dispatch namespace before it reports success.
#
# This refuses rather than forwarding, deliberately. `push` uploads the values in the
# env file; it does not mint new ones. A shim that quietly ran it would answer a request
# to ROTATE by setting the current secrets again and printing "done" — the same class of
# silent wrong outcome that put this notice here.
#
# The replacement, in full:
#
#   node scripts/secrets.mjs generate --keys SERVICE_TOKEN,PLATFORM_SECRET,ROUTER_SECRET --force
#   node scripts/secrets.mjs push --env prod          # workers, then the whole fleet
#   pnpm --filter @substrat-run/control-plane cf:deploy
#
# `generate` writes the new values into secrets/platform.prod.env, which the old script
# never did — and Cloudflare never gives a secret back, so a value that exists only in
# the deployed worker is a value you cannot check, diff or restore.
#
set -euo pipefail

cat >&2 <<'EOF'
✗ tools/set-platform-secrets.sh has been removed (#979).

  It stopped after the three platform workers and left the vertical re-put as a
  printed reminder — the step whose absence took the hosted fleet down on 2026-08-01.

  Rotate the three shared tokens with:

    node scripts/secrets.mjs generate --keys SERVICE_TOKEN,PLATFORM_SECRET,ROUTER_SECRET --force
    node scripts/secrets.mjs push --env prod          # workers, THEN every vertical
    pnpm --filter @substrat-run/control-plane cf:deploy

  `pnpm secrets:platform` is now the second of those. See scripts/secrets.mjs.
EOF
exit 1
