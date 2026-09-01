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
describe('the privileged worker bundles no vertical module code', () => {
  // `.href` on the way in deliberately: the worker types put a DOM `URL` in scope, which
  // is not node's, so the object overload of `fileURLToPath` does not accept it here.
  const read = (rel: string) => readFileSync(fileURLToPath(new URL(`../${rel}`, import.meta.url).href), 'utf8');
  /** Every `from '<specifier>'` in a source file, in order. */
  const importsOf = (src: string) => [...src.matchAll(/from\s+'([^']+)'/g)].map((m) => m[1]!);

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
