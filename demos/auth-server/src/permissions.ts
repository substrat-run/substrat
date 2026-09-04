import { definePermissions } from '@substrat-run/contracts';

// The manifest's config surface rides the same import `substrat push` already makes for
// `permissions` (#1206): this export is what the push uploads, so `src/manifest.ts` is the
// single envSpec declaration and package.json carries no copy.
export { AUTH_SERVER_ENV as envSpec } from './manifest.js';

/**
 * The auth-server's permission surface — explicitly empty (D-41). It registers no kernel
 * modules and stamps no role templates: it is a standalone Better Auth issuer whose entire
 * authorization model is Better Auth's own `admin` flag on the user row (src/auth.ts), not
 * Substrat permissions. Declared rather than omitted so a push can tell "this vertical has
 * no permission surface" apart from "this vertical forgot to declare one".
 */
export const permissions = definePermissions({ modules: [], roles: [] });
