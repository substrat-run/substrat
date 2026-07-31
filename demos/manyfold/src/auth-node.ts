import { join } from 'node:path';
import Database from 'better-sqlite3';
import { betterAuth, type BetterAuthOptions } from 'better-auth';
import { getMigrations } from 'better-auth/db/migration';

/**
 * Better Auth as the Manyfold dev server's authentication — the SAME contract the
 * deployed worker uses (a per-tenant IdentityDO running Better Auth, or an OIDC issuer);
 * here it runs in node against its OWN SQLite store, entirely separate from the scope
 * databases. Authentication only — the kernel keeps authorization (roles, grants,
 * tenancy), so Better Auth's organization/RBAC plugins stay off by design.
 *
 * There is NO impersonation path anymore: dev and prod both resolve a real session →
 * subject → the principal that login is bound to (the identity directory). The dev
 * server just seeds a login per cast member so the demo runs out of the box.
 *
 * Node-only (`better-sqlite3`, `node:path`) — harness code.
 *
 * `baseURL`/`trustedOrigins` must include the WEB origin, because the browser calls
 * `/api/auth/*` through Vite's proxy and Better Auth checks Origin against that list.
 */
export function buildAuthNode(dir: string, baseURL: string, trustedOrigins: string[]) {
  const db = new Database(join(dir, 'better-auth.sqlite'));
  db.pragma('journal_mode = WAL');
  const options: BetterAuthOptions = {
    database: db,
    emailAndPassword: { enabled: true, autoSignIn: true, minPasswordLength: 8 },
    secret: process.env.BETTER_AUTH_SECRET ?? 'dev-only-secret-substrat-manyfold-demo-32c',
    baseURL,
    trustedOrigins,
  };
  return betterAuth(options);
}

export type AuthNode = ReturnType<typeof buildAuthNode>;

/** Create Better Auth's own tables (user/session/account/verification) if absent. */
export async function migrateAuth(auth: AuthNode): Promise<void> {
  const { runMigrations } = await getMigrations(auth.options);
  await runMigrations();
}
