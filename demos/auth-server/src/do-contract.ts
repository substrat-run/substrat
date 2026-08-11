/**
 * The issuer DO's callable contract, split from the class so the HTTP layer (`app.ts`)
 * and node tests can depend on the SHAPE without importing `cloudflare:workers`
 * (`auth-do.ts` is worker-build-only). The class implements this; the app only ever
 * holds a stub.
 */

/** Instance metadata the platform records at provision (K-31, hosted mode). */
export interface InstanceMeta {
  tenantId: string;
  scopeId: string;
  slug: string;
  name: string;
}

/** One delivered config entry — a declared env-spec key and its per-instance value. */
export interface ConfigEntry {
  key: string;
  value: string;
}

/** The DO's callable surface (avoids leaking the full class type through the binding). */
export type AuthServerStub = {
  fetch(request: Request): Promise<Response>;
  needsSetup(): Promise<boolean>;
  setupFirstAdmin(origin: string, creds: { email: string; password: string; name: string }): Promise<{ id: string }>;
  provisionInstance(meta: InstanceMeta, config?: ConfigEntry[]): Promise<void>;
  setInstanceConfig(entries: ConfigEntry[]): Promise<void>;
  /** §5.4 admin-query reads (the dashboard Data tab); secrets are redacted inside the DO. */
  introspectTables(): Promise<import('@substrat-run/contracts').ScopeTable[]>;
  introspectTable(
    table: string,
    limit: number,
    offset: number,
  ): Promise<import('@substrat-run/contracts').ScopeTablePage>;
  /** The full-fidelity dump (#590) — deliberately UNredacted; the control plane is the gate. */
  exportDump(): Promise<import('@substrat-run/contracts').ScopeDumpTable[]>;
  /** Wipe this issuer's storage irreversibly (#590) — the reap/rebind half. */
  destroyStorage(): Promise<void>;
};

/** The verified subject behind a session, as the `/__session` probe returns it. */
export interface SessionSubject {
  sub: string;
  email: string | null;
  name: string | null;
  role: string | null;
}
