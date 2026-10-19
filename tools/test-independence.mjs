/**
 * The independence checkpoint (model-phase-plan.md §6).
 *
 * Every defect worth catching is two descriptions disagreeing. Once the code is
 * derived from the model, the code is a FUNCTION of the model and can no longer
 * contradict it — so the second description has to be the tests, and they are
 * only a second description if they were written from the concept.
 *
 * A scenario test that imports `spec/model.ts` builds its inputs from the very
 * schema it is meant to judge. It cannot disagree with that schema, so it will
 * pass against a wrong model perfectly and forever. That is the one thing this
 * refuses.
 *
 * A second, unrelated way a test agrees with whatever it is given: a bare RegExp as a
 * `toMatchObject` value is never applied (#2313) — see `tools/bare-regexp.mjs`. Every tracked
 * script file that mentions `toMatchObject` is read, whatever it is named.
 *
 * A third: a fixture's `version` label built from a slice of an id collides with another version
 * of the same slug now and then (#2402) — see `tools/version-label.mjs`. Every tracked script
 * file is read, a generated one excepted.
 *
 * Exit codes follow boundary-lint's: 0 = fine, 1 = a violation, 2 = the tool
 * could not do its job. A checkpoint that checked nothing must never print a
 * green light.
 */
import { readdirSync, readFileSync, existsSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { findBareRegExps, REMEDY } from './bare-regexp.mjs';
import { findTruncatedVersions, REMEDY as VERSION_REMEDY } from './version-label.mjs';

const GROUPS = ['demos', 'engines'];
const violations = [];
let checked = 0;

for (const group of GROUPS) {
  if (!existsSync(group)) continue;
  for (const name of readdirSync(group)) {
    const dir = join(group, name);
    if (!statSync(dir).isDirectory()) continue;
    const testDir = join(dir, 'test');
    if (!existsSync(testDir)) continue;

    for (const file of readdirSync(testDir)) {
      if (!/^scenario\.test\.[cm]?tsx?$/.test(file)) continue;
      const path = join(testDir, file);
      checked += 1;
      const src = readFileSync(path, 'utf8');
      for (const [i, line] of src.split('\n').entries()) {
        const m = /^\s*import\s[^;]*from\s+['"]([^'"]+)['"]/.exec(line);
        if (!m) continue;
        const from = m[1];
        if (/(^|\/)spec\//.test(from) || /\/spec$/.test(from)) {
          violations.push(
            `${path}:${i + 1}  imports '${from}'\n` +
              '    A scenario test is the concept\'s independent claim about the app. Importing\n' +
              '    the model makes it a mirror of the model: it cannot disagree, so it cannot\n' +
              '    catch a wrong one. Use literal inputs and assert literal outputs.',
          );
        }
      }
    }
  }
}

const SCRIPT = /\.[cm]?[jt]sx?$/;
let matcherFiles = 0;
for (const path of execFileSync('git', ['ls-files', '-z'], { encoding: 'utf8', maxBuffer: 1 << 28 })
  .split('\0')
  .filter((f) => SCRIPT.test(f) && existsSync(f))) {
  const src = readFileSync(path, 'utf8');
  if (!path.includes('.generated.') && src.includes('version')) {
    for (const { line, text } of findTruncatedVersions(src)) {
      violations.push(`${path}:${line}  version label from part of an id: ${text}\n    ${VERSION_REMEDY}`);
    }
  }
  if (!src.includes('toMatchObject')) continue;
  matcherFiles += 1;
  for (const { line, text } of findBareRegExps(src)) {
    violations.push(`${path}:${line}  bare ${text} inside toMatchObject\n    ${REMEDY}`);
  }
}

if (checked === 0) {
  console.error('test-independence: found no scenario tests to check — run from the repo root');
  process.exit(2);
}
if (violations.length > 0) {
  console.error(`test-independence: ${violations.length} violation(s)\n`);
  for (const v of violations) console.error(`  ${v}\n`);
  process.exit(1);
}
console.log(
  `test-independence: ${checked} scenario suite(s) independent of the model; ` +
    `${matcherFiles} file(s) with toMatchObject hold no bare RegExp; no version label is cut from an id`,
);
