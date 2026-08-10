import { definePermissions } from '@substrat-run/contracts';

/**
 * The auth-server's permission surface — explicitly empty (D-41). It registers no kernel
 * modules and stamps no role templates: it is a standalone Better Auth issuer whose entire
 * authorization model is Better Auth's own `admin` flag on the user row (src/auth.ts), not
 * Substrat permissions. Declared rather than omitted so a push can tell "this vertical has
 * no permission surface" apart from "this vertical forgot to declare one".
 */
export const permissions = definePermissions({ modules: [], roles: [] });
