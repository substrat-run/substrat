import { existsSync, readFileSync } from 'node:fs';

/**
 * Local provider credentials for the live suites — one file for every connector.
 *
 * ## Why `secrets/connectors.env` and not `secrets/platform.<env>.env`
 *
 * They look interchangeable and are not. `platform.<env>.env` is a **push map**:
 * `scripts/secrets.mjs push` uploads every key in it to the deployed Cloudflare Workers,
 * and re-puts the shared pair on every vertical. A provider credential must never take
 * that path. A connector credential's home is a **sealed connection** in the directory,
 * opened per (tenant, vertical, provider) — the thing that makes a leaked token cost one
 * tenant's one integration rather than the fleet. Putting one in the worker-secret file
 * would hand it to module code as ambient env, which is the hole #862 closed.
 *
 * So this is a sibling file that `scripts/secrets.mjs` does not know about and never
 * pushes. It is gitignored by the existing `secrets/*.env` rule, and its `.example`
 * template is committed like the platform ones.
 *
 * ## Resolution order
 *
 * A flag or environment variable wins, then `secrets/connectors.env`, then the
 * connector's own legacy `.dev.vars`, then a default. The shared file is canonical; the
 * per-connector file is kept working so an existing checkout (Scrive's, filled with real
 * testbed credentials) does not break on the day this landed.
 *
 * Keys are `<PROVIDER>_`-prefixed precisely because one file now holds several
 * providers: `FORTNOX_CLIENT_SECRET` and `SCRIVE_CLIENT_SECRET` are different secrets
 * and must not be able to collide.
 */

/** Parse a flat `KEY=value` env file. Blank values are treated as absent. */
function parseEnvFile(path: string): Record<string, string> {
  if (!existsSync(path)) return {};
  const out: Record<string, string> = {};
  for (const line of readFileSync(path, 'utf8').split('\n')) {
    const m = /^([A-Z0-9_]+)=(.*)$/.exec(line.trim());
    if (m && m[2] !== '') out[m[1]!] = m[2]!;
  }
  return out;
}

/**
 * Merge the shared connector secrets over a connector's own `.dev.vars`.
 *
 * `sharedPath` is `secrets/connectors.env`; `legacyPath` is the package's `.dev.vars`.
 * Shared wins, so a repo that has migrated is not silently overridden by a stale local
 * file it forgot to delete.
 */
export function loadDevSecrets(sharedPath: string, legacyPath: string): Record<string, string> {
  return { ...parseEnvFile(legacyPath), ...parseEnvFile(sharedPath) };
}

export { parseEnvFile };
