/**
 * The platform bindings a scope object counts its own rows through (#3316), by origin — the
 * vertical's operation or a platform verb — into an Analytics Engine dataset. Named here, beside
 * `MIGRATIONS_DIGEST_BINDING`, because the uploader (control-plane-api) injects them and the scope
 * host (adapter-cloudflare) reads them, and neither may import the other.
 */

/** The Analytics Engine dataset binding. No binding, no count: the host runs unmetered. */
export const SCOPE_WORK_BINDING = 'SUBSTRAT_SCOPE_WORK';

/** The vertical's slug, as plain text, so each point names the vertical without a directory read. */
export const SCOPE_WORK_VERTICAL_BINDING = 'SUBSTRAT_VERTICAL';

/**
 * Which script the object runs in, as plain text: `live` on the vertical's serving script, `preview`
 * on a version's own script (which is where a preview's fork lands). The script is what Cloudflare
 * bills a namespace under, so this is the same split its analytics make.
 */
export const SCOPE_WORK_KIND_BINDING = 'SUBSTRAT_SCRIPT_KIND';

/** The two values {@link SCOPE_WORK_KIND_BINDING} holds. */
export type ScopeWorkScriptKind = 'live' | 'preview';
