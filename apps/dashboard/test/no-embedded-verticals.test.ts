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
 * a comment, of either kind", so an interposed comment cannot hide a specifier either; it
 * can only ever consume characters immediately following the keyword, never skip over code.
 */
const SEP = String.raw`(?:\s|/\*[\s\S]*?\*/|//[^\n]*\n)*`;
const IMPORT_SPECIFIER = new RegExp(String.raw`(?:from|import)${SEP}\(?${SEP}['"]([^'"]+)['"]`, 'g');

/**
 * A NAMED import, with its clause captured. An import clause's braces cannot nest, so
 * `[^}]*` matches the whole list exactly — no lazy scan that could run past a statement.
 * `type` is captured because a type-only import erases at compile time: it binds no value
 * and can bundle no code, so it is exempt from the constants-only rule below.
 */
const NAMED_IMPORT = new RegExp(String.raw`import${SEP}(type${SEP})?\{([^}]*)\}${SEP}from${SEP}['"]([^'"]+)['"]`, 'g');

/**
 * The engine the dashboard composes AS A VERTICAL (layer 3): `src/module.ts` calls its
 * in-scope functions and `src/provision.ts` registers `invitesModule` in this deployment's
 * own ScopeDO. That is a vertical using an engine, which is the architecture working — not
 * the privileged worker hosting somebody else's vertical. Every OTHER engine is here for
 * its permission keys alone.
 */
const COMPOSED_ENGINE = '@substrat-run/engine-invites';

describe('the privileged worker bundles no vertical module code', () => {
  // `.href` on the way in deliberately: the worker types put a DOM `URL` in scope, which
  // is not node's, so the object overload of `fileURLToPath` does not accept it here.
  const read = (rel: string) => readFileSync(fileURLToPath(new URL(`../${rel}`, import.meta.url).href), 'utf8');
  /** Every module specifier in a source file, in order. */
  const importsOf = (src: string) => [...src.matchAll(IMPORT_SPECIFIER)].map((m) => m[1]!);
  /**
   * Every named import, as `{ spec, names }`. `names` are the names the ENGINE exports —
   * the alias is dropped, because `PROTOCOL_PERM as PROTO` is still a constant and
   * `workorderModule as PERM` is still a module. Type bindings are dropped too, whether
   * the whole clause is `import type` or a single entry is `{ type Invoice, … }`: a type
   * erases at compile time, so it binds no value and can bundle no code.
   */
  const namedImportsOf = (src: string) =>
    [...src.matchAll(NAMED_IMPORT)].map((m) => ({
      spec: m[3]!,
      names: m[1]
        ? []
        : m[2]!
            .split(',')
            .map((s) => s.trim())
            .filter((s) => s && !/^type\s/.test(s))
            .map((s) => s.split(/\s+as\s+/)[0]!.trim()),
    }));

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

  it('an engine it does not compose is imported for permission KEYS and nothing else', () => {
    // The residue #978 asks about, and the reason it is allowed to stay: `catalog.ts`
    // takes `PROTOCOL_PERM`, `PERM` and `INVOICING_PERM` off three engines so a seeded
    // owner-grant is the engine's OWN spelling of a key rather than a literal that drifts
    // silently (CLAUDE.md: permission keys are never renamed, so the constant is stable).
    // Nothing executes: an engine's exports are only *values* here, never a registration.
    //
    // As prose that would have been the whole claim, and prose is what stopped being true
    // the last time. A SCREAMING_SNAKE export is a constant; `workorderModule`,
    // `createWorkOrder` and `completeWorkOrder` are not — so the NAME SHAPE is what
    // separates "reads a key" from "runs, or drives, an engine", and asserting on it is
    // what keeps the comment in `src/catalog.ts` honest.
    for (const file of ['src/worker.ts', 'src/provision.ts', 'src/module.ts', 'src/catalog.ts', 'src/authority.ts']) {
      const src = read(file);
      const named = namedImportsOf(src);
      const specs = importsOf(src).filter((s) => s.startsWith('@substrat-run/engine-') && s !== COMPOSED_ENGINE);
      for (const spec of new Set(specs)) {
        // COUNT, not existence: a namespace, default, side-effect or dynamic import binds
        // the engine's whole surface, so it offers no name to judge and must be refused
        // outright. Comparing counts refuses it even when a legitimate named import of the
        // same package sits beside it — `toBeGreaterThan(0)` would let that pair through.
        const clauses = named.filter((n) => n.spec === spec);
        const occurrences = specs.filter((s) => s === spec).length;
        expect(clauses.length, `${file} → ${spec}: every import of it must be \`import { NAMED } from\``).toBe(occurrences);
        for (const name of clauses.flatMap((c) => c.names)) {
          expect(`${file} → ${spec} → ${name}`).toMatch(/→ [A-Z][A-Z0-9_]*$/);
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
      `await import(/* lazy */ '@substrat-run/demo-v/module');`, // block comment before the specifier
      `export { d } from '@substrat-run/demo-u/module';`, // re-export
      `import // why\n'@substrat-run/demo-t/module';`, // line comment, side-effect
      `void import(// why\n'@substrat-run/demo-s/module');`, // line comment, dynamic
    ].join('\n');
    expect(importsOf(src)).toEqual([
      '@substrat-run/demo-x/module',
      '@substrat-run/demo-y/module',
      '@substrat-run/demo-z/module',
      '@substrat-run/demo-w/module',
      '@substrat-run/demo-v/module',
      '@substrat-run/demo-u/module',
      '@substrat-run/demo-t/module',
      '@substrat-run/demo-s/module',
    ]);
  });

  it('the named-import matcher reads a clause the way the compiler does', () => {
    // Same contract as the list above: each line is a real shape the constants-only rule
    // has to judge, and the rule is only as honest as this reading of the clause.
    const src = [
      `import { PERM } from '@substrat-run/engine-workorder';`, // plain
      `import { PROTOCOL_PERM as PROTO, workorderModule } from '@substrat-run/engine-protocol';`, // aliased + a value
      `import type { WorkOrder } from '@substrat-run/engine-workorder';`, // type-only clause
      `import { type Invoice, INVOICING_PERM } from '@substrat-run/engine-invoicing';`, // inline type
      `import\n  {\n    A,\n  }\n  from '@substrat-run/engine-absence';`, // newlines throughout
    ].join('\n');
    expect(namedImportsOf(src)).toEqual([
      { spec: '@substrat-run/engine-workorder', names: ['PERM'] },
      // The ALIAS is discarded and the exported name kept: `PROTOCOL_PERM as anything` is
      // still a constant, and `workorderModule as PERM` must still read as a module.
      { spec: '@substrat-run/engine-protocol', names: ['PROTOCOL_PERM', 'workorderModule'] },
      { spec: '@substrat-run/engine-workorder', names: [] }, // whole clause erased
      { spec: '@substrat-run/engine-invoicing', names: ['INVOICING_PERM'] }, // `type Invoice` erased
      { spec: '@substrat-run/engine-absence', names: ['A'] },
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
