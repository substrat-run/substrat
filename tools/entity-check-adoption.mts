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
 * call `entityCheckConformanceSuite(` fewer times than it has modules declaring such operations —
 * the suite takes one module's operations — counting calls in code only, comments blanked. Which operations the suite then
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
}

/**
 * A package whose modules declare entity checks calls the suite once per such module: the suite
 * takes one module's operations. Calls are counted in the test code, comments blanked, so a
 * suite mentioned in prose or commented out is not one.
 */
export function adoptionOffences(packages: readonly Judged[]): string[] {
  return packages.flatMap(({ label, modules, tests }) => {
    const declaring = modules.filter((m) => m.targeted.length > 0);
    if (declaring.length === 0) return [];
    const calls = tests.reduce((n, text) => n + [...blankComments(text).matchAll(SUITE_CALL)].length, 0);
    if (calls >= declaring.length) return [];
    const ops = declaring.flatMap((m) => m.targeted);
    const named = `${ops.length} operation(s) declare an entity check (${ops.slice(0, 3).join(', ')}${ops.length > 3 ? ', …' : ''})`;
    return [
      calls === 0
        ? `${label}: ${named} and no test calls entityCheckConformanceSuite`
        : `${label}: ${declaring.length} module(s) declare entity checks (${declaring.map((m) => m.id).join(', ')}) and the tests call entityCheckConformanceSuite ${calls} time(s) — once per module`,
    ];
  });
}

async function main(): Promise<void> {
  const packages = await registrations('entity-check-adoption', { template: false });
  const judged = packages.map(({ label, own }) => ({
    label,
    modules: own.map((m) => ({ id: m.manifest.id, targeted: targetedOperations(m) })),
    tests: testFiles(join(process.cwd(), label)).map((f) => readFileSync(f, 'utf8')),
  }));
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

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await main();
}
