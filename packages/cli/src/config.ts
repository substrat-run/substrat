import { readFileSync, writeFileSync, mkdirSync, chmodSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

/**
 * The CLI's stored credentials. A service token is a machine credential (the same
 * `SERVICE_TOKEN` the control plane holds); it resolves to the platform's service
 * actor. Kept in `~/.substrat/config.json`, chmod 600 — a home-dir file, never in a
 * repo. A push reads it so you authenticate once with `substrat login`, not per call.
 */
export interface CliConfig {
  controlPlaneUrl?: string;
  /** A browser-login session (sent as `Authorization: Bearer`) — per-human, from `substrat login`. */
  bearerToken?: string;
  /** A shared machine credential (sent as `x-service-token`) — for CI, from `substrat login --token`. */
  serviceToken?: string;
  /**
   * The tenant a builder acts for (builder-plane.md §5) — the id or slug the control plane
   * prefixes onto a bare `--slug` to form `<tenantSlug>/<name>`. Stored by `substrat login`
   * (the sole/selected workspace); `--tenant` overrides per command. Sent as
   * `x-substrat-tenant` with every auth kind: a browser session becomes a builder narrowed
   * to it, and a service token keeps its staff reach but the control plane uses it to
   * resolve a bare slug to the workspace's `<tenantSlug>/<name>` registry id (#417).
   *
   * `push` deliberately does NOT fall back to this (`useDefaultTenant: false`): which
   * workspace owns a vertical is a property of the project (package.json `substrat.tenant`),
   * and a silently-wrong machine-wide default would claim `<wrong-tenant>/<slug>` on first
   * push. For push this is only the pre-filled suggestion in the interactive picker.
   */
  defaultTenant?: string;
}

const configDir = (): string => join(homedir(), '.substrat');
const configFile = (): string => join(configDir(), 'config.json');

export function loadConfig(): CliConfig {
  try {
    return JSON.parse(readFileSync(configFile(), 'utf8')) as CliConfig;
  } catch {
    return {};
  }
}

/** Write the config 0600 (best-effort chmod — a no-op on platforms without it). */
export function saveConfig(cfg: CliConfig): string {
  mkdirSync(configDir(), { recursive: true });
  const path = configFile();
  writeFileSync(path, JSON.stringify(cfg, null, 2) + '\n');
  try {
    chmodSync(path, 0o600);
  } catch {
    /* best effort */
  }
  return path;
}

export interface ResolvedAuth {
  controlPlaneUrl: string;
  /** The auth header to send with an authenticated request. */
  header: Record<string, string>;
  /** Human description of how we authenticated (for the CLI to print). */
  as: string;
  /** 'session' = a per-human browser login (tenant-scoped); 'service' = the platform actor. */
  kind: 'session' | 'service';
}

/**
 * Resolve the control-plane URL + the auth header, in precedence order:
 *   URL:   flag → SUBSTRAT_CP_URL → config
 *   auth:  explicit service token (flag/env, for CI) → stored browser session → stored service token
 * A browser session is sent as `Authorization: Bearer` (per-human, roster-gated); a
 * service token as `x-service-token` (the platform service actor). Throws a clear,
 * actionable error pointing at `substrat login` rather than surfacing a 401 later.
 */
export function resolveAuth(flags: {
  cp?: string;
  token?: string;
  tenant?: string;
  /** false = never fall back to the stored defaultTenant (push — the project decides). */
  useDefaultTenant?: boolean;
}): ResolvedAuth {
  const cfg = loadConfig();
  const raw = flags.cp ?? process.env.SUBSTRAT_CP_URL ?? cfg.controlPlaneUrl;
  if (!raw) {
    throw new Error('no control-plane URL — pass --cp, set SUBSTRAT_CP_URL, or run `substrat login`');
  }
  const controlPlaneUrl = raw.replace(/\/$/, '');

  // The workspace this command acts for: `--tenant` → SUBSTRAT_TENANT → the stored default
  // (unless the caller opted out — push resolves its tenant from the project instead).
  // Sent with EVERY auth kind (#417): a browser session becomes a builder narrowed to it,
  // while a service token stays staff — the control plane then only uses the header to
  // resolve a bare slug to the workspace's `<tenantSlug>/<name>` registry id, so
  // `versions`/`promote` reach the same rows over either credential.
  const tenant =
    flags.tenant ??
    process.env.SUBSTRAT_TENANT ??
    (flags.useDefaultTenant === false ? undefined : cfg.defaultTenant);
  const withTenant = (header: Record<string, string>): Record<string, string> =>
    tenant ? { ...header, 'x-substrat-tenant': tenant } : header;
  const forWorkspace = (how: string): string => (tenant ? `${how} (workspace ${tenant})` : how);

  const explicitService = flags.token ?? process.env.SUBSTRAT_SERVICE_TOKEN;
  if (explicitService) {
    return {
      controlPlaneUrl,
      header: withTenant({ 'x-service-token': explicitService }),
      as: forWorkspace('service token'),
      kind: 'service',
    };
  }
  if (cfg.bearerToken) {
    return {
      controlPlaneUrl,
      header: withTenant({ authorization: `Bearer ${cfg.bearerToken}` }),
      as: forWorkspace('browser session'),
      kind: 'session',
    };
  }
  if (cfg.serviceToken) {
    return {
      controlPlaneUrl,
      header: withTenant({ 'x-service-token': cfg.serviceToken }),
      as: forWorkspace('service token'),
      kind: 'service',
    };
  }
  throw new Error('not authenticated — run `substrat login` (browser), or pass --token / set SUBSTRAT_SERVICE_TOKEN for CI');
}
