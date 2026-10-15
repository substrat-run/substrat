import { describe, expect, it } from 'vitest';
import { generateScopeStoreKeyPair } from '@substrat-run/contracts/scope-store-envelope';
import {
  STORE_CLASS_PLACEHOLDER,
  STORE_ENTRY_MODULE,
  STORE_KIND_PLACEHOLDER,
  STORE_OBJECT_BINDING,
  STORE_OBJECT_CLASS,
  STORE_RESERVED_MODULES,
  STORE_VERIFIER_MODULE,
  withPythonStoreEntry,
  withStoreEntry,
} from '../src/store-entry.js';

/**
 * What the store upload refuses before it builds anything (#2289, D-63): the entry's reserved
 * names, an unusable kind entry or class, and keys that would let one audience sign for the
 * other. The workerd half — the entry admitting and refusing calls — is
 * apps/vertical-egress/test/store-entry.workerd.test.ts.
 */
const module = (name: string) => ({ name, content: new TextEncoder().encode('export class Kind {}'), contentType: 'application/javascript+module' });
const kindBundle = (patch: Record<string, unknown> = {}) => ({ entry: 'kind.js', modules: [module('kind.js')], doClasses: [], bindings: [], ...patch });

describe('withStoreEntry', async () => {
  const caller = await generateScopeStoreKeyPair();
  const platform = await generateScopeStoreKeyPair();
  const options = { className: 'Kind', script: 'substrat-store-counter-docs', callerPublicKeys: [caller.publicKey], platformPublicKeys: [platform.publicKey] };

  it('puts the entry in front of the kind, with the script name and both key lists bound', () => {
    const uploaded = withStoreEntry(kindBundle(), options);
    expect(uploaded.entry).toBe(STORE_ENTRY_MODULE);
    expect(uploaded.modules.map((m) => m.name)).toEqual([STORE_ENTRY_MODULE, 'kind.js']);
    const source = new TextDecoder().decode(uploaded.modules[0]!.content);
    expect(source).toContain('"./kind.js"');
    expect(source).not.toContain(STORE_KIND_PLACEHOLDER);
    expect(source).not.toContain(STORE_CLASS_PLACEHOLDER);
    expect(uploaded.doClasses).toEqual([STORE_OBJECT_CLASS]);
    expect(uploaded.compatibilityFlags).toEqual(['disallow_importable_env', 'disable_ctx_exports']);
    // A kind's own flags are kept beside it, once.
    expect(withStoreEntry(kindBundle({ compatibilityFlags: ['nodejs_compat', 'disallow_importable_env'] }), options).compatibilityFlags).toEqual([
      'nodejs_compat',
      'disallow_importable_env',
      'disable_ctx_exports',
    ]);
    expect(uploaded.bindings).toEqual([
      { type: 'durable_object_namespace', name: STORE_OBJECT_BINDING, class_name: STORE_OBJECT_CLASS },
      { type: 'plain_text', name: 'SUBSTRAT_STORE_SCRIPT', text: options.script },
      { type: 'plain_text', name: 'SUBSTRAT_STORE_CALLER_KEYS', text: caller.publicKey },
      { type: 'plain_text', name: 'SUBSTRAT_STORE_PLATFORM_KEYS', text: platform.publicKey },
    ]);
  });

  it.each([
    ['a module named like the entry', kindBundle({ modules: [module('kind.js'), module(STORE_ENTRY_MODULE)] }), {}, /may not ship a module/],
    ['the entry itself as the kind entry', kindBundle({ entry: STORE_ENTRY_MODULE }), {}, /not a module name/],
    ['a kind entry outside the bundle', kindBundle({ entry: '../kind.js' }), {}, /not a module name/],
    ['a kind entry that climbs out midway', kindBundle({ entry: 'a/../kind.js' }), {}, /not a module name/],
    ['a flag that gives the kind the script env back', kindBundle({ compatibilityFlags: ['allow_importable_env'] }), {}, /allow_importable_env/],
    ['a flag that gives the kind ctx.exports back', kindBundle({ compatibilityFlags: ['enable_ctx_exports'] }), {}, /enable_ctx_exports/],
    ['a kind entry that is not JavaScript', kindBundle({ entry: 'kind.wasm' }), {}, /not a module name/],
    ["the entry's object class", kindBundle({ doClasses: [STORE_OBJECT_CLASS] }), {}, /may not declare the class/],
    ["the entry's class as the kind class", kindBundle(), { className: STORE_OBJECT_CLASS }, /entry's own object class/],
    ['a class name that is not an identifier', kindBundle(), { className: 'Kind; evil()' }, /not an identifier/],
    ['a reserved binding', kindBundle({ bindings: [{ type: 'plain_text', name: 'SUBSTRAT_STORE_CALLER_KEYS' }] }), {}, /may not declare the binding/],
    ['an empty script name', kindBundle(), { script: '' }, /script name/],
  ] as const)('refuses %s', (_, bundle, patch, error) => {
    expect(() => withStoreEntry(bundle, { ...options, ...patch })).toThrow(error);
  });

  it.each(STORE_RESERVED_MODULES)("refuses a kind bundle that ships the platform's module '%s'", (name) => {
    expect(() => withStoreEntry(kindBundle({ modules: [module('kind.js'), module(name)] }), options)).toThrow(
      `may not ship a module named '${name}'`,
    );
  });

  it('reserves the Python entry and its verifier beside the JavaScript entry', () => {
    expect(STORE_RESERVED_MODULES).toEqual([STORE_ENTRY_MODULE, 'substrat_store_entry.py', STORE_VERIFIER_MODULE]);
    expect(() => withStoreEntry(kindBundle({ entry: STORE_VERIFIER_MODULE, modules: [module(STORE_VERIFIER_MODULE)] }), options)).toThrow(
      /not a module name/,
    );
  });

  it('refuses one key for both audiences, a key listed twice, and an empty list; admits a rotation', async () => {
    expect(() => withStoreEntry(kindBundle(), { ...options, platformPublicKeys: [caller.publicKey] })).toThrow(/both audiences/);
    expect(() => withStoreEntry(kindBundle(), { ...options, platformPublicKeys: [] })).toThrow(/empty/);
    expect(() => withStoreEntry(kindBundle(), { ...options, callerPublicKeys: [caller.publicKey, caller.publicKey] })).toThrow(/twice/);
    const next = await generateScopeStoreKeyPair();
    const rotated = withStoreEntry(kindBundle(), { ...options, platformPublicKeys: [platform.publicKey, next.publicKey] });
    expect(rotated.bindings.at(-1)).toEqual({ type: 'plain_text', name: 'SUBSTRAT_STORE_PLATFORM_KEYS', text: `${platform.publicKey},${next.publicKey}` });
  });
});

describe('withPythonStoreEntry', async () => {
  const caller = await generateScopeStoreKeyPair();
  const platform = await generateScopeStoreKeyPair();
  const options = { className: 'GraphStore', script: 'substrat-store-graph-acme_crm', callerPublicKeys: [caller.publicKey], platformPublicKeys: [platform.publicKey] };
  const py = (name: string) => ({ name, content: new TextEncoder().encode('class GraphStore: pass\n') });
  const release = (patch: Record<string, unknown> = {}) => ({
    entry: 'kind_graph/store.py',
    modules: [py('kind_graph/store.py'), py('kind_graph/schema/tables.py')],
    ...patch,
  });

  it('puts the Python entry first, imports the kind by its dotted path, and keeps the bytes', () => {
    const given = release();
    const script = withPythonStoreEntry(given, options);
    expect(script.mainModule).toBe('substrat_store_entry.py');
    expect(script.modules.map((m) => [m.name, m.contentType])).toEqual([
      ['substrat_store_entry.py', 'text/x-python'],
      [STORE_VERIFIER_MODULE, 'application/javascript+module'],
      ['kind_graph/store.py', 'text/x-python'],
      ['kind_graph/schema/tables.py', 'text/x-python'],
    ]);
    const entry = new TextDecoder().decode(script.modules[0]!.content);
    expect(entry).toContain('from kind_graph.store import GraphStore as StoreKind');
    expect(entry).not.toContain(STORE_KIND_PLACEHOLDER);
    expect(entry).not.toContain(STORE_CLASS_PLACEHOLDER);
    // The kind's modules are the release's own bytes, not a decoded and re-encoded copy.
    expect(script.modules[2]!.content).toBe(given.modules[0]!.content);
    expect(script.compatibilityFlags).toEqual(['python_workers', 'disallow_importable_env', 'disable_ctx_exports']);
    expect(script.bindings).toEqual([
      { type: 'durable_object_namespace', name: STORE_OBJECT_BINDING, class_name: STORE_OBJECT_CLASS },
      { type: 'plain_text', name: 'SUBSTRAT_STORE_SCRIPT', text: options.script },
      { type: 'plain_text', name: 'SUBSTRAT_STORE_CALLER_KEYS', text: caller.publicKey },
      { type: 'plain_text', name: 'SUBSTRAT_STORE_PLATFORM_KEYS', text: platform.publicKey },
    ]);
  });

  it.each([
    ['a module outside a kind_ package', release({ modules: [py('kind_graph/store.py'), py('helpers.py')] }), {}, /helpers\.py/],
    ["a module that shadows the runtime's", release({ modules: [py('kind_graph/store.py'), py('workers.py')] }), {}, /workers\.py/],
    ["the Python entry's own name", release({ modules: [py('kind_graph/store.py'), py('substrat_store_entry.py')] }), {}, /substrat_store_entry\.py/],
    ["the verifier's name", release({ modules: [py('kind_graph/store.py'), py(STORE_VERIFIER_MODULE)] }), {}, /substrat-store-verify/],
    ["the upload's metadata part", release({ modules: [py('kind_graph/store.py'), py('metadata')] }), {}, /'metadata'/],
    ['a module that climbs out', release({ modules: [py('kind_graph/../store.py')] }), {}, /may not ship/],
    ['a module that is not Python', release({ modules: [py('kind_graph/store.py'), py('kind_graph/data.json')] }), {}, /data\.json/],
    ['a module named twice', release({ modules: [py('kind_graph/store.py'), py('kind_graph/store.py')] }), {}, /twice/],
    ['two packages', release({ modules: [py('kind_graph/store.py'), py('kind_other/x.py')] }), {}, /more than one package/],
    ['an entry that is not one of the modules', release({ entry: 'kind_graph/missing.py' }), {}, /not one of the release's modules/],
    ["the entry's object class as the kind class", release(), { className: STORE_OBJECT_CLASS }, /entry's own object class/],
    ['a class name that is not a Python identifier', release(), { className: 'Graph$Store' }, /not an identifier/],
    ['an empty script name', release(), { script: '' }, /script name/],
    ['one key for both audiences', release(), { platformPublicKeys: [caller.publicKey] }, /both audiences/],
  ] as const)('refuses %s', (_, bad, patch, error) => {
    expect(() => withPythonStoreEntry(bad, { ...options, ...patch })).toThrow(error);
  });
});
