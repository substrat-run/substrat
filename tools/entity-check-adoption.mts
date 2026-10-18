/**
 * A package whose operations address one entity runs the entity-check conformance suite
 * (#2365, S2 of the review checklist).
 *
 * An operation that declares `permission: { key, entity, idFrom }` promises a check against that
 * one entity, and nothing in the type system holds the handler to it: `ctx.check(perm)` without
 * the entity typechecks and lets every member reach every record. `entityCheckConformanceSuite`
 * (`@substrat-run/contract-tests`) is what tells the two apart, generated from the declarations
 * themselves (#747) — but only in a package that calls it. A new vertical, or an engine whose
 * first entity-addressed operation lands, could declare targets and never run it, and every
 * suite would stay green.
 *
 * So this reads each package's own modules (the set `lint:migration-fence` reads, without the
 * template), takes the operations whose declared surface addresses an entity by id
 * (`declaredSurfaceOf`, the record `operationInputsOf` keeps), and refuses a package whose tests
 * never call `entityCheckConformanceSuite(` (in code: comments are blanked), and one with a module
 * whose entity-checked operations are not all in the operations its conformance declaration
 * (`substrat.conformance`, the object the suite is handed) names. Which operations the suite then
 * covers, and which it lists as uncovered, is the suite's own assertion.
 *
 * What this does not reach: an operation with a bare scope-wide key that checks nothing at all.
 * No declaration distinguishes it, so that half stays the reader's (S2 `judgement`).
 *
 * Exit 0: every such package runs the suite. 1: at least one does not. 2: cannot run.
 * Needs the build.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { blankComments } from './attachment-writers.mjs';
import { declaredSurfaceOf } from '../packages/contracts/dist/index.js';
import { isMainModule } from './repo-path.mjs';
import { registrations, testFiles, type Registration } from './package-registrations.mts';

const SUITE_CALL = /\bentityCheckConformanceSuite\s*\(/g;

/** The operations one module declares as addressing one entity by id. */
export function targetedOperations(module: Registration): string[] {
  const surface = declaredSurfaceOf((module.operations as { inputs?: object } | undefined)?.inputs);
  return surface ? Object.keys(surface.targets) : [];
}

export interface Judged {
  readonly label: string;
  /** Each own module that declares entity checks, with those operations. */
  readonly modules: readonly { readonly id: string; readonly targeted: readonly string[] }[];
  readonly tests: readonly string[];
  /**
   * The operations the package's conformance declaration (`substrat.conformance`) hands the suite,
   * or undefined when it names none.
   */
  readonly covered: ReadonlySet<string> | undefined;
}

/**
 * A package whose modules declare entity checks calls the suite in its test code (comments
 * blanked, so a call in prose or commented out is not one), and every such operation, module by
 * module, is in the conformance declaration the suite runs over. Two calls over one module's
 * operations leave the other module's uncovered, and that is refused by name.
 */
export function adoptionOffences(packages: readonly Judged[]): string[] {
  return packages.flatMap(({ label, modules, tests, covered }) => {
    const declaring = modules.filter((m) => m.targeted.length > 0);
    if (declaring.length === 0) return [];
    const ops = declaring.flatMap((m) => m.targeted);
    const list = (xs: readonly string[]): string => `${xs.slice(0, 3).join(', ')}${xs.length > 3 ? ', …' : ''}`;
    const calls = tests.reduce((n, text) => n + [...blankComments(text).matchAll(SUITE_CALL)].length, 0);
    if (calls === 0) return [`${label}: ${ops.length} operation(s) declare an entity check (${list(ops)}) and no test calls entityCheckConformanceSuite`];
    if (!covered) return [`${label}: calls entityCheckConformanceSuite but names no conformance declaration (substrat.conformance), so what it covers cannot be read`];
    return declaring.flatMap((m) => {
      const missing = m.targeted.filter((op) => !covered.has(op));
      return missing.length === 0 ? [] : [`${label}: module ${m.id} declares entity checks the conformance suite is not given (${list(missing)})`];
    });
  });
}

/** The operations every export of a conformance declaration hands the suite. */
async function coveredBy(label: string): Promise<Set<string> | undefined> {
  const entry = (JSON.parse(readFileSync(join(label, 'package.json'), 'utf8')) as { substrat?: { conformance?: unknown } }).substrat?.conformance;
  if (typeof entry !== 'string') return undefined;
  const mod = (await import(pathToFileURL(join(process.cwd(), label, entry)).href)) as Record<string, unknown>;
  return new Set(
    Object.values(mod).flatMap((v) => {
      const ops = (v as { operations?: unknown } | null)?.operations;
      return typeof ops === 'object' && ops !== null ? Object.keys(ops) : [];
    }),
  );
}

async function main(): Promise<void> {
  const packages = await registrations('entity-check-adoption', { template: false });
  const judged: Judged[] = [];
  for (const { label, own } of packages) {
    const modules = own.map((m) => ({ id: m.manifest.id, targeted: targetedOperations(m) }));
    const declares = modules.some((m) => m.targeted.length > 0);
    judged.push({
      label,
      modules,
      tests: declares ? testFiles(join(process.cwd(), label)).map((f) => readFileSync(f, 'utf8')) : [],
      covered: declares ? await coveredBy(label) : undefined,
    });
  }
  const offences = adoptionOffences(judged);
  if (offences.length > 0) {
    console.error(`entity-check-adoption: ${offences.length} package(s) declare entity checks nothing verifies:\n`);
    for (const o of offences) console.error(`  ${o}`);
    console.error(
      '\nAdd test/entity-checks.test.ts calling entityCheckConformanceSuite from @substrat-run/contract-tests;\n' +
        'demos/todo/test/entity-checks.test.ts is the reference.',
    );
    process.exit(1);
  }
  const targeted = (p: Judged): number => p.modules.reduce((n, m) => n + m.targeted.length, 0);
  const adopters = judged.filter((p) => targeted(p) > 0);
  console.log(
    `entity-check-adoption: ${adopters.length} package(s) declare entity checks (${adopters.reduce((n, p) => n + targeted(p), 0)} operations); every one runs the conformance suite.`,
  );
}

if (isMainModule(import.meta.url)) {
  await main();
}
