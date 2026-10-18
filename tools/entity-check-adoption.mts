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
 * (`declaredSurfaceOf`, the record `operationInputsOf` keeps), and refuses a package that has
 * any and no test file calling `entityCheckConformanceSuite(`. Which operations the suite then
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
import { declaredSurfaceOf } from '../packages/contracts/dist/index.js';
import { registrations, type Registration } from './migration-registrations.mts';
import { testFiles } from './operation-tests.mts';

const SUITE_CALL = /\bentityCheckConformanceSuite\s*\(/;

/** The operations `modules` declare as addressing one entity by id. */
export function targetedOperations(modules: readonly Registration[]): string[] {
  return modules.flatMap((m) => {
    const surface = declaredSurfaceOf((m.operations as { inputs?: object } | undefined)?.inputs);
    return surface ? Object.keys(surface.targets) : [];
  });
}

export function adoptionOffences(packages: readonly { label: string; targeted: readonly string[]; tests: readonly string[] }[]): string[] {
  return packages
    .filter((p) => p.targeted.length > 0 && !p.tests.some((text) => SUITE_CALL.test(text)))
    .map(
      (p) =>
        `${p.label}: ${p.targeted.length} operation(s) declare an entity check (${p.targeted.slice(0, 3).join(', ')}` +
        `${p.targeted.length > 3 ? ', …' : ''}) and no test calls entityCheckConformanceSuite`,
    );
}

async function main(): Promise<void> {
  const packages = await registrations('entity-check-adoption', { template: false });
  const engineModules = new Set(packages.filter((p) => p.label.startsWith('engines/')).flatMap((p) => p.modules.map((m) => m.manifest.id)));
  const judged = packages.map(({ label, modules }) => ({
    label,
    targeted: targetedOperations(label.startsWith('engines/') ? modules : modules.filter((m) => !engineModules.has(m.manifest.id))),
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
  const adopters = judged.filter((p) => p.targeted.length > 0);
  console.log(
    `entity-check-adoption: ${adopters.length} package(s) declare entity checks (${adopters.reduce((n, p) => n + p.targeted.length, 0)} operations); every one runs the conformance suite.`,
  );
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await main();
}
