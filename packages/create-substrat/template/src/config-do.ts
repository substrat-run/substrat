import { DurableObject } from 'cloudflare:workers';

/**
 * The key the platform delivers a scope's identity-provider choice under.
 *
 * It lives HERE rather than in `worker.ts` for a runtime reason worth knowing: workerd
 * requires every named export of the entry module to be a handler or a Durable Object
 * class, so exporting a plain constant from `worker.ts` makes the whole worker fail to
 * boot — with a `tsc`-clean tree and a green test suite. Config vocabulary belongs with
 * the config store anyway.
 */
export const AUTH_CONFIG_KEY = 'substrat:auth';

/**
 * The vertical's own per-instance CONFIG store — the durable half of
 * `/internal/configure`.
 *
 * The platform delivers per-install settings (the dashboard's Settings → Env and
 * Identity tabs) by POSTing them to `/internal/configure` on this worker. A vertical
 * that supplies no `onConfigure` hook answers 501 to that call for its whole life:
 * the dashboard records the setting, reports `delivered: false`, and the running app
 * never sees it. This DO is what makes the hook answerable.
 *
 * It is a HARNESS store, not module code — the config a scope runs on is not domain
 * data, and it must survive a scope-DO storage wipe (a restore, a rebind), so it
 * deliberately lives outside the scope's own DO. One DO per TENANT, rows keyed by
 * scope; the table matches `scope_config` in `@substrat-run/vertical-auth`'s
 * `IdentityDO` exactly, so a project that later adopts vertical-auth for real logins
 * swaps the binding and keeps its rows.
 *
 * Sandbox-clean (D-18): this is one of the deployment's OWN Durable Object classes,
 * declared in package.json `substrat.runtimeNeeds.stores`. No control-plane binding,
 * no service binding — the platform refuses those.
 */
export class ConfigDO extends DurableObject<Record<string, never>> {
  private ready = false;

  /** Lazily create the table — cheaper than a blockConcurrencyWhile on every wake. */
  private init(): void {
    if (this.ready) return;
    this.ctx.storage.sql.exec(
      `CREATE TABLE IF NOT EXISTS scope_config (
         scope_id TEXT NOT NULL, key TEXT NOT NULL, value TEXT NOT NULL,
         PRIMARY KEY (scope_id, key))`,
    );
    this.ready = true;
  }

  /**
   * Upsert config delivered for one scope. Key-by-key rather than a replace, so a
   * partial delivery composes with what is already there; idempotent, so the
   * platform's reconciliation sweep can re-run it safely.
   */
  async setScopeConfig(scopeId: string, entries: Array<{ key: string; value: string }>): Promise<void> {
    this.init();
    for (const { key, value } of entries) {
      this.ctx.storage.sql.exec(
        'INSERT OR REPLACE INTO scope_config (scope_id, key, value) VALUES (?, ?, ?)',
        scopeId, key, value,
      );
    }
  }

  /**
   * The config delivered to one scope, as a plain map — exactly the `delivered`
   * argument of `resolveScopedEnvSpec(spec, env, delivered)`. Reading it back is what
   * keeps the hook from being write-only: an env-spec key set per install must be
   * overlaid here, because env-spec defaults ride as worker bindings SHARED by every
   * install of one serving script, so reading `env` alone always yields the shared
   * default no matter what the tenant saved.
   */
  async getScopeConfig(scopeId: string): Promise<Record<string, string>> {
    this.init();
    const config: Record<string, string> = {};
    for (const row of this.ctx.storage.sql.exec('SELECT key, value FROM scope_config WHERE scope_id = ?', scopeId)) {
      config[row.key as string] = row.value as string;
    }
    return config;
  }
}

/** The typed stub surface — what `worker.ts` calls across the DO boundary. */
export interface ConfigDo {
  setScopeConfig(scopeId: string, entries: Array<{ key: string; value: string }>): Promise<void>;
  getScopeConfig(scopeId: string): Promise<Record<string, string>>;
}
