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
 *
 * The entry is also how the platform supplies a scope sweeper (#1902). A version that
 * declares schedules needs a `defineScopeSweeperDO` class exported from its main module, or
 * the schedules never fire on a hosted deploy (#1646) — a second rule every vertical had to
 * remember. Now one that brings none is given the platform's, re-exported from this entry;
 * `platformSweeperDecision` says when, from the push's declaration alone, and the version
 * keeps that answer for every later upload.
 */
import type { VerticalBundle } from './deploy.js';
import {
  PLATFORM_ENTRY_MODULE,
  PLATFORM_ENTRY_PLACEHOLDER,
  PLATFORM_ENTRY_SOURCE,
  PLATFORM_SWEEPER_CLASS,
  PLATFORM_SWEEPER_MODULE,
  PLATFORM_SWEEPER_SOURCE,
} from './platform-entry.generated.js';

export { PLATFORM_ENTRY_MODULE, PLATFORM_SWEEPER_CLASS, PLATFORM_SWEEPER_MODULE };

/** The binding the supplied sweeper is reached by — the template's and both demos' name. */
export const PLATFORM_SWEEPER_BINDING = 'SWEEPER';
/** Names that binding for `mountPlatformSurface` (`@substrat-run/vertical-host`'s
 *  `PLATFORM_SWEEPER_VAR`), which is what tells it the roster is its to keep. */
export const PLATFORM_SWEEPER_VAR = 'SUBSTRAT_SCOPE_SWEEPER';

const PLATFORM_MODULES = new Set([PLATFORM_ENTRY_MODULE, PLATFORM_SWEEPER_MODULE]);

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
    if (PLATFORM_MODULES.has(m.name) || !isScript(m)) continue;
    const text = decoder.decode(m.content);
    writes ||= WRITES_THE_LINE.test(text);
    shares ||= text.includes(SHARES_THE_STAMP);
  }
  if (writes && !shares) return 'the bundle writes the invocation line with a kernel that predates the platform stamp';
  return undefined;
}

/** The facts the sweeper decision reads — all of them declared, none read from the bytes. */
export interface SweeperFacts {
  /** The version declares recurring `schedules` — what makes it owe a sweeper. */
  declaresSchedules?: boolean;
  /** The manifest's `sweeperClasses`: the vertical's own sweeper classes, `[]` for none,
   *  absent when a CLI from before the field pushed it. */
  sweeperClasses?: string[];
  /** The bindings the version declares. */
  bindings?: VerticalBundle['bindings'];
}

/** What {@link platformSweeperPlan} decided: supply the platform's sweeper, or not and why — or refuse the push. */
export type SweeperPlan = { supply: true } | { supply: false; why: string } | { refuse: string };

/**
 * Whether the platform supplies a version's scope sweeper (#1902), from what its push
 * DECLARED: the manifest's `schedules` and `sweeperClasses`, and the deploy config's bindings.
 *
 * Decided ONCE, at push, and recorded with the version (the stored manifest's
 * `platformSweeper`): every later upload of it — promote, re-serve, backout — reuses the
 * record rather than calling this again. A refusal can therefore only ever stop a push, never
 * the promotion or rollback of a version that was accepted, and a version pushed before the
 * decision existed keeps exactly what it had.
 *
 * Why it is the sweeper's names (`SweeperDO` bound as `SWEEPER`) that the platform takes:
 * they are what the template and both hosted demos exported by hand, so a vertical that drops
 * its own keeps the same Durable Object namespace on its serving script — the same singleton,
 * its roster and its armed alarm — and the in-place migration delta is empty. Any other name
 * would be a class rename, which is a migration the uploader does not write.
 *
 * The bundle's bytes are deliberately not consulted: an export's name, or a method name
 * inside a minified build, says nothing reliable about which class is a sweeper. A push from
 * a CLI that predates `sweeperClasses` falls back to the convention — `SWEEPER` bound to
 * `SweeperDO` is the vertical's own, neither name bound means it has none — and refuses the
 * half-matches it cannot tell apart, rather than guessing either way: a wrong "it has one"
 * leaves the schedules unrun, and a wrong "it has none" runs them twice.
 */
export function platformSweeperPlan(facts: SweeperFacts): SweeperPlan {
  if (!facts.declaresSchedules) return { supply: false, why: 'the version declares no schedules' };
  const bindings = facts.bindings ?? [];
  const own = facts.sweeperClasses;
  // Bindings, not `doClasses`: a class stays in a config's migration history after its export
  // is deleted (migrations are append-only), and only a binding is a live use of a name.
  const boundClasses = bindings.filter((b) => b.type === 'durable_object_namespace').map((b) => b.class_name);
  const byName = bindings.find((b) => b.name === PLATFORM_SWEEPER_BINDING);
  const byClass = boundClasses.includes(PLATFORM_SWEEPER_CLASS);
  const refuse = (why: string): SweeperPlan => ({ refuse: `cannot run this version's declared schedules: ${why}` });
  if (own && own.length > 0) {
    const bound = own.filter((c) => boundClasses.includes(c));
    if (bound.length === 0) {
      return refuse(
        `the worker entry exports its own sweeper (${own.join(', ')}), but no Durable Object binding names ` +
          `that class, so Cloudflare never instantiates it and its alarm never runs. Bind it as a store, ` +
          `or delete it and let the platform supply one`,
      );
    }
    return { supply: false, why: `the vertical brings its own sweeper (${bound.join(', ')})` };
  }
  if (own) {
    // The push read no sweeper in the source: the platform's goes in, under names nothing else may hold.
    if (byName || byClass) {
      return refuse(
        `the platform supplies a sweeper as class '${PLATFORM_SWEEPER_CLASS}' bound to '${PLATFORM_SWEEPER_BINDING}', and ` +
          `this version already binds ${byName ? `the name '${PLATFORM_SWEEPER_BINDING}'` : `the class '${PLATFORM_SWEEPER_CLASS}'`} ` +
          `to something that is not a defineScopeSweeperDO class. If it is a sweeper you have since deleted, drop ` +
          `its binding — the platform adds its own — and otherwise rename it`,
      );
    }
    return { supply: true };
  }
  // A CLI from before `sweeperClasses`: the convention is all there is to read.
  if (byName?.type === 'durable_object_namespace' && byName.class_name === PLATFORM_SWEEPER_CLASS) {
    return { supply: false, why: `the vertical binds '${PLATFORM_SWEEPER_CLASS}' as '${PLATFORM_SWEEPER_BINDING}', the conventional own sweeper` };
  }
  if (!byName && !byClass) return { supply: true };
  return refuse(
    `this push carries no sweeperClasses (its CLI predates them), and its config binds ` +
      `${byName ? `the name '${PLATFORM_SWEEPER_BINDING}' to another class` : `the class '${PLATFORM_SWEEPER_CLASS}' under another name`}, ` +
      `so whether it brings its own sweeper cannot be told. Push again with a current @substrat-run/cli`,
  );
}

/**
 * The push-time decision, whole (#1902): {@link platformSweeperPlan}, plus the one thing the
 * plan alone cannot know — that the platform's entry, which re-exports the sweeper, will
 * wrap this bundle at all. A bundle the entry skips could not carry it, and recording
 * "supplied" for it would be a lie every later upload repeats, so that case refuses too.
 */
export function platformSweeperDecision(
  facts: SweeperFacts,
  bundle: Pick<VerticalBundle, 'entry' | 'modules'>,
): { supply: boolean } | { refuse: string } {
  const plan = platformSweeperPlan(facts);
  if ('refuse' in plan) return plan;
  if (!plan.supply) return { supply: false };
  const skip = platformEntrySkipReason(bundle);
  if (skip !== undefined) {
    return {
      refuse:
        `cannot run this version's declared schedules: the platform supplies a sweeper through its entry ` +
        `module, and this bundle cannot take one (${skip}). Update @substrat-run/kernel and ` +
        `@substrat-run/vertical-host, or export your own sweeper`,
    };
  }
  return { supply: true };
}

/**
 * The bundle as uploaded: the platform's entry module added (or refreshed) and named as
 * the script's main module, importing the vertical's own entry — and, when the version's
 * recorded decision says so (`supplySweeper`), the platform's sweeper beside it: its module,
 * the entry's re-export of its class, the class in `doClasses` (so the migration the uploader
 * derives declares it) and its binding, plus the var that hands its roster to
 * `mountPlatformSurface`. Never decides and never refuses: it does what the push decided. A
 * bundle the platform cannot or need not wrap comes back unchanged, apart from dropping stale
 * platform modules it can no longer reach.
 */
export function withPlatformEntry<
  B extends Pick<VerticalBundle, 'entry' | 'modules'> & Partial<Pick<VerticalBundle, 'doClasses' | 'bindings' | 'supplySweeper'>>,
>(bundle: B): B {
  const supply = bundle.supplySweeper === true;
  if (platformEntrySkipReason(bundle) !== undefined) return bundle;
  const own = bundle.modules.filter((m) => !PLATFORM_MODULES.has(m.name));
  const encode = (text: string) => new TextEncoder().encode(text);
  // Module names are paths from the script root, where the platform entry sits too.
  let source = PLATFORM_ENTRY_SOURCE.split(PLATFORM_ENTRY_PLACEHOLDER).join(`./${bundle.entry}`);
  if (supply) source += `export { ${PLATFORM_SWEEPER_CLASS} } from "./${PLATFORM_SWEEPER_MODULE}";\n`;
  const kind = 'application/javascript+module';
  return {
    ...bundle,
    entry: PLATFORM_ENTRY_MODULE,
    modules: [
      { name: PLATFORM_ENTRY_MODULE, content: encode(source), contentType: kind },
      ...(supply ? [{ name: PLATFORM_SWEEPER_MODULE, content: encode(PLATFORM_SWEEPER_SOURCE), contentType: kind }] : []),
      ...own,
    ],
    ...(supply
      ? {
          // Deduplicated: a vertical that dropped its own `SweeperDO` keeps the class in its
          // migration history, and the class must be declared once.
          doClasses: [...new Set([...(bundle.doClasses ?? []), PLATFORM_SWEEPER_CLASS])],
          bindings: [
            ...(bundle.bindings ?? []),
            { type: 'durable_object_namespace', name: PLATFORM_SWEEPER_BINDING, class_name: PLATFORM_SWEEPER_CLASS },
            // `text` is not a declared binding's field — this one the platform writes, never the vertical.
            { type: 'plain_text', name: PLATFORM_SWEEPER_VAR, text: PLATFORM_SWEEPER_BINDING } as VerticalBundle['bindings'][number],
          ],
        }
      : {}),
  };
}
