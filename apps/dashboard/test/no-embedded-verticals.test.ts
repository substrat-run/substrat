import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, it, expect } from 'vitest';
import { MODULES } from '../src/index.js';

/**
 * The dashboard is the one PRIVILEGED deployment — it holds the control plane's service
 * credential and can provision into any of its callers' tenants. So it must not also be a
 * place vertical module code runs (#978, master-plan D-33: a demo is a template that is
 * COPIED, not imported). It used to bundle Callout, Meridian and Manyfold plus five
 * engines into its own ScopeDO as the "M0 embedded path", which meant a vertical's
 * operations executed inside the worker holding that credential.
 *
 * These are SOURCE assertions on purpose. The regression they guard is an import — one
 * line, added because a demo module was the quickest way to make something run — and no
 * behavioural test catches an import that merely widens what is bundled. Reading the
 * file is what makes the rule mechanical rather than a comment nobody re-reads.
 */
/**
 * A module specifier, matched on its QUOTES rather than on the `from` keyword. `from`
 * alone misses the forms that carry none, and a side-effect `import '…/module'` registers
 * a vertical exactly as thoroughly as a named import does — it is the shape someone
 * reaches for when re-adding a module they have no symbol to use. `SEP` is "whitespace or
 * a block comment", so an interposed comment cannot hide a specifier either; it can only
 * ever consume characters immediately following the keyword, never skip over code.
 */
const SEP = String.raw`(?:\s|/\*[\s\S]*?\*/)*`;
const IMPORT_SPECIFIER = new RegExp(String.raw`(?:from|import)${SEP}\(?${SEP}['"]([^'"]+)['"]`, 'g');

describe('the privileged worker bundles no vertical module code', () => {
  // `.href` on the way in deliberately: the worker types put a DOM `URL` in scope, which
  // is not node's, so the object overload of `fileURLToPath` does not accept it here.
  const read = (rel: string) => readFileSync(fileURLToPath(new URL(`../${rel}`, import.meta.url).href), 'utf8');
  /** Every module specifier in a source file, in order. */
  const importsOf = (src: string) => [...src.matchAll(IMPORT_SPECIFIER)].map((m) => m[1]!);

  it('the ScopeDO runs the dashboard vertical and nothing else', () => {
    // `provision.ts`'s list, which is also what `lint:permissions` renders PERMISSIONS.md
    // from — so what the DO runs and what the checkpoint documents cannot drift apart.
    expect(MODULES.map((m) => m.manifest.id)).toEqual(['@substrat-run/dashboard', '@substrat-run/engine-invites']);
  });

  it('no worker source imports a vertical module — a demo is reachable only as data', () => {
    for (const file of ['src/worker.ts', 'src/provision.ts', 'src/module.ts', 'src/catalog.ts', 'src/authority.ts']) {
      for (const spec of importsOf(read(file))) {
        // `…/module` is a vertical's registered code — operations, consumers, migrations.
        // That is the import this issue was about, and it belongs in the vertical's own
        // deployment, never here.
        expect(`${file} → ${spec}`).not.toMatch(/\/module$/);
        // What a demo may still be read for is DATA: `catalog.ts` takes Callout's
        // permission KEYS off its manifest so the seeded owner-grants are the vertical's
        // own spelling rather than a copy that drifts. No other subpath of a demo.
        if (spec.startsWith('@substrat-run/demo-')) {
          expect(`${file} → ${spec}`).toBe(`${file} → ${spec.split('/').slice(0, 2).join('/')}/manifest`);
        }
      }
    }
  });

  it('the matcher sees every import form a module could arrive through', () => {
    // The guard is only as good as this list. Each line is a real way to register a
    // vertical module, and each one escaped an earlier draft of the regex.
    const src = [
      `import { a } from '@substrat-run/demo-x/module';`, // named
      `import '@substrat-run/demo-y/module';`, // side-effect — no `from` at all
      `import b from "@substrat-run/demo-z/module";`, // double-quoted
      `const c = await import('@substrat-run/demo-w/module');`, // dynamic
      `await import(/* lazy */ '@substrat-run/demo-v/module');`, // comment before the specifier
      `export { d } from '@substrat-run/demo-u/module';`, // re-export
    ].join('\n');
    expect(importsOf(src)).toEqual([
      '@substrat-run/demo-x/module',
      '@substrat-run/demo-y/module',
      '@substrat-run/demo-z/module',
      '@substrat-run/demo-w/module',
      '@substrat-run/demo-v/module',
      '@substrat-run/demo-u/module',
    ]);
  });

  it('declares meridian and absence as TEST-only dependencies', () => {
    // They are registered by `test/scenario.test.ts`'s single-process host, which stands in
    // for the separate deployments an app really runs on. A devDependency does not reach
    // the worker bundle; moving one back to `dependencies` restores the embedded path.
    const pkg = JSON.parse(read('package.json')) as { dependencies: Record<string, string>; devDependencies: Record<string, string> };
    expect(pkg.dependencies['@substrat-run/demo-meridian']).toBeUndefined();
    expect(pkg.dependencies['@substrat-run/engine-absence']).toBeUndefined();
    expect(pkg.devDependencies['@substrat-run/demo-meridian']).toBeDefined();
    expect(pkg.devDependencies['@substrat-run/engine-absence']).toBeDefined();
  });
});
