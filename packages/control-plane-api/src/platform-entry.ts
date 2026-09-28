/**
 * The platform stamps every request a vertical serves (#1893).
 *
 * A vertical's tenant-facing logs are the one line `invocationLog` writes per request —
 * and for a year that line existed only when the vertical remembered to mount the
 * middleware first on its app. Boundary-lint R10 and a push warning made forgetting loud;
 * neither made it impossible, and a vertical that forgot served an empty Logs view that
 * read as "no traffic". So the platform no longer asks: at upload it puts its own entry
 * module in front of the bundle's, and that module wraps the vertical's default export
 * with the kernel's `withInvocationLog`.
 *
 * Three facts about bundles decide the shape:
 *
 * - **A bundle that mounts the middleware too is fine.** A current kernel's middleware
 *   finds the platform's stamp on the request and steps aside, so the request is logged
 *   once, and the operation route still writes its record onto the one line.
 * - **An older kernel does not know to step aside**, so wrapping it would log every request
 *   twice. A bundle that writes the line itself (it carries the line's marker) but not the
 *   shared stamp registry is uploaded as it is: it already logs, and re-pushing on a
 *   current kernel is what moves it over.
 * - **The archive script is the bundle store** that promote and backout re-upload from, so
 *   a re-served bundle already holds a platform entry. It is replaced with the current
 *   one, never stacked: the manifest's `entry` is always the vertical's own module.
 */
import type { VerticalBundle } from './deploy.js';
import {
  PLATFORM_ENTRY_MODULE,
  PLATFORM_ENTRY_PLACEHOLDER,
  PLATFORM_ENTRY_SOURCE,
} from './platform-entry.generated.js';

export { PLATFORM_ENTRY_MODULE };

/** The line `invocationLog` writes, as it appears in any build: `substrat:"invocation"`. */
const WRITES_THE_LINE = /substrat['"]?\s*:\s*["']invocation["']/;
/** The registry a current kernel shares with the platform's copy. */
const SHARES_THE_STAMP = 'substrat.invocation-stamp';

const isScript = (m: VerticalBundle['modules'][number]) =>
  m.contentType.includes('javascript') || /\.(m?js|cjs)$/.test(m.name);

/**
 * Why a bundle is uploaded without the platform's entry, or `undefined` when it gets one.
 * Exported for the upload's own tests and for anyone asking why a script is not wrapped.
 */
export function platformEntrySkipReason(bundle: Pick<VerticalBundle, 'entry' | 'modules'>): string | undefined {
  if (bundle.entry === PLATFORM_ENTRY_MODULE) {
    return 'the bundle names the platform entry as its own, so the vertical entry it wraps is unknown';
  }
  if (!bundle.modules.some((m) => m.name === bundle.entry)) return 'the bundle holds no module named by its entry';
  const decoder = new TextDecoder();
  let writes = false;
  let shares = false;
  for (const m of bundle.modules) {
    if (m.name === PLATFORM_ENTRY_MODULE || !isScript(m)) continue;
    const text = decoder.decode(m.content);
    writes ||= WRITES_THE_LINE.test(text);
    shares ||= text.includes(SHARES_THE_STAMP);
  }
  if (writes && !shares) return 'the bundle writes the invocation line with a kernel that predates the platform stamp';
  return undefined;
}

/**
 * The bundle as uploaded: the platform's entry module added (or refreshed) and named as
 * the script's main module, importing the vertical's own entry. A bundle the platform
 * cannot or need not wrap comes back unchanged, apart from dropping a stale platform
 * entry it can no longer reach.
 */
export function withPlatformEntry<B extends Pick<VerticalBundle, 'entry' | 'modules'>>(bundle: B): B {
  if (platformEntrySkipReason(bundle) !== undefined) return bundle;
  const own = bundle.modules.filter((m) => m.name !== PLATFORM_ENTRY_MODULE);
  // Module names are paths from the script root, where the platform entry sits too.
  const source = PLATFORM_ENTRY_SOURCE.split(PLATFORM_ENTRY_PLACEHOLDER).join(`./${bundle.entry}`);
  return {
    ...bundle,
    entry: PLATFORM_ENTRY_MODULE,
    modules: [
      { name: PLATFORM_ENTRY_MODULE, content: new TextEncoder().encode(source), contentType: 'application/javascript+module' },
      ...own,
    ],
  };
}
