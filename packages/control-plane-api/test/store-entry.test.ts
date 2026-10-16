import { describe, expect, it } from 'vitest';
import { generateScopeStoreKeyPair } from '@substrat-run/contracts/scope-store-envelope';
import {
  STORE_CLASS_PLACEHOLDER,
  STORE_ENTRY_MODULE,
  STORE_DRIVER_PLACEHOLDER,
  STORE_OBJECT_BINDING,
  STORE_OBJECT_CLASS,
  STORE_RESERVED_MODULES,
  STORE_VERIFIER_MODULE,
  withPythonStoreEntry,
  withStoreEntry,
} from '../src/store-entry.js';

/**
 * What the store upload refuses before it builds anything (#2289, D-63): the entry's reserved
 * names, an unusable driver entry or class, and keys that would let one audience sign for the
 * other. The workerd half — the entry admitting and refusing calls — is
 * apps/vertical-egress/test/store-entry.workerd.test.ts.
 */
const module = (name: string) => ({ name, content: new TextEncoder().encode('export class Driver {}'), contentType: 'application/javascript+module' });
const driverBundle = (patch: Record<string, unknown> = {}) => ({ entry: 'driver.js', modules: [module('driver.js')], doClasses: [], bindings: [], ...patch });

describe('withStoreEntry', async () => {
  const caller = await generateScopeStoreKeyPair();
  const platform = await generateScopeStoreKeyPair();
  const options = { className: 'Driver', script: 'substrat-store-counter-docs', callerPublicKeys: [caller.publicKey], platformPublicKeys: [platform.publicKey] };

  it('puts the entry in front of the driver, with the script name and both key lists bound', () => {
    const uploaded = withStoreEntry(driverBundle(), options);
    expect(uploaded.entry).toBe(STORE_ENTRY_MODULE);
    expect(uploaded.modules.map((m) => m.name)).toEqual([STORE_ENTRY_MODULE, 'driver.js']);
    const source = new TextDecoder().decode(uploaded.modules[0]!.content);
    expect(source).toContain('"./driver.js"');
    expect(source).not.toContain(STORE_DRIVER_PLACEHOLDER);
    expect(source).not.toContain(STORE_CLASS_PLACEHOLDER);
    expect(uploaded.doClasses).toEqual([STORE_OBJECT_CLASS]);
    expect(uploaded.compatibilityFlags).toEqual(['disallow_importable_env', 'disable_ctx_exports']);
    // A driver's own flags are kept beside it, once.
    expect(withStoreEntry(driverBundle({ compatibilityFlags: ['nodejs_compat', 'disallow_importable_env'] }), options).compatibilityFlags).toEqual([
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
    ['a module named like the entry', driverBundle({ modules: [module('driver.js'), module(STORE_ENTRY_MODULE)] }), {}, /may not ship a module/],
    ['the entry itself as the driver entry', driverBundle({ entry: STORE_ENTRY_MODULE }), {}, /not a module name/],
    ['a driver entry outside the bundle', driverBundle({ entry: '../driver.js' }), {}, /not a module name/],
    ['a driver entry that climbs out midway', driverBundle({ entry: 'a/../driver.js' }), {}, /not a module name/],
    ['a flag that gives the driver the script env back', driverBundle({ compatibilityFlags: ['allow_importable_env'] }), {}, /allow_importable_env/],
    ['a flag that gives the driver ctx.exports back', driverBundle({ compatibilityFlags: ['enable_ctx_exports'] }), {}, /enable_ctx_exports/],
    ['a driver entry that is not JavaScript', driverBundle({ entry: 'driver.wasm' }), {}, /not a module name/],
    ["the entry's object class", driverBundle({ doClasses: [STORE_OBJECT_CLASS] }), {}, /may not declare the class/],
    ["the entry's class as the driver class", driverBundle(), { className: STORE_OBJECT_CLASS }, /entry's own object class/],
    ['a class name that is not an identifier', driverBundle(), { className: 'Driver; evil()' }, /not an identifier/],
    ['a reserved binding', driverBundle({ bindings: [{ type: 'plain_text', name: 'SUBSTRAT_STORE_CALLER_KEYS' }] }), {}, /may not declare the binding/],
    ['an empty script name', driverBundle(), { script: '' }, /script name/],
  ] as const)('refuses %s', (_, bundle, patch, error) => {
    expect(() => withStoreEntry(bundle, { ...options, ...patch })).toThrow(error);
  });

  it.each(STORE_RESERVED_MODULES)("refuses a driver bundle that ships the platform's module '%s'", (name) => {
    expect(() => withStoreEntry(driverBundle({ modules: [module('driver.js'), module(name)] }), options)).toThrow(
      `may not ship a module named '${name}'`,
    );
  });

  it('reserves the Python entry and its verifier beside the JavaScript entry', () => {
    expect(STORE_RESERVED_MODULES).toEqual([STORE_ENTRY_MODULE, 'substrat_store_entry.py', STORE_VERIFIER_MODULE]);
    expect(() => withStoreEntry(driverBundle({ entry: STORE_VERIFIER_MODULE, modules: [module(STORE_VERIFIER_MODULE)] }), options)).toThrow(
      /not a module name/,
    );
  });

  it('refuses one key for both audiences, a key listed twice, and an empty list; admits a rotation', async () => {
    expect(() => withStoreEntry(driverBundle(), { ...options, platformPublicKeys: [caller.publicKey] })).toThrow(/both audiences/);
    expect(() => withStoreEntry(driverBundle(), { ...options, platformPublicKeys: [] })).toThrow(/empty/);
    expect(() => withStoreEntry(driverBundle(), { ...options, callerPublicKeys: [caller.publicKey, caller.publicKey] })).toThrow(/twice/);
    const next = await generateScopeStoreKeyPair();
    const rotated = withStoreEntry(driverBundle(), { ...options, platformPublicKeys: [platform.publicKey, next.publicKey] });
    expect(rotated.bindings.at(-1)).toEqual({ type: 'plain_text', name: 'SUBSTRAT_STORE_PLATFORM_KEYS', text: `${platform.publicKey},${next.publicKey}` });
  });
});

describe('withPythonStoreEntry', async () => {
  const caller = await generateScopeStoreKeyPair();
  const platform = await generateScopeStoreKeyPair();
  const options = { className: 'GraphStore', script: 'substrat-store-graph-acme_crm', callerPublicKeys: [caller.publicKey], platformPublicKeys: [platform.publicKey] };
  const py = (name: string) => ({ name, content: new TextEncoder().encode('class GraphStore: pass\n') });
  const release = (patch: Record<string, unknown> = {}) => ({
    entry: 'driver_graph/store.py',
    modules: [py('driver_graph/store.py'), py('driver_graph/schema/tables.py')],
    ...patch,
  });

  it('puts the Python entry first, imports the driver by its dotted path, and keeps the bytes', () => {
    const given = release();
    const script = withPythonStoreEntry(given, options);
    expect(script.mainModule).toBe('substrat_store_entry.py');
    expect(script.modules.map((m) => [m.name, m.contentType])).toEqual([
      ['substrat_store_entry.py', 'text/x-python'],
      [STORE_VERIFIER_MODULE, 'application/javascript+module'],
      ['driver_graph/store.py', 'text/x-python'],
      ['driver_graph/schema/tables.py', 'text/x-python'],
    ]);
    const entry = new TextDecoder().decode(script.modules[0]!.content);
    expect(entry).toContain('from driver_graph.store import GraphStore as StoreDriver');
    expect(entry).not.toContain(STORE_DRIVER_PLACEHOLDER);
    expect(entry).not.toContain(STORE_CLASS_PLACEHOLDER);
    // The driver's modules are the release's own bytes, not a decoded and re-encoded copy.
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
    ['a module outside a driver_ package', release({ modules: [py('driver_graph/store.py'), py('helpers.py')] }), {}, /helpers\.py/],
    ["a module that shadows the runtime's", release({ modules: [py('driver_graph/store.py'), py('workers.py')] }), {}, /workers\.py/],
    // A package of its own, so only the driver_ prefix refuses it: the runtime's own modules.
    ["a package that shadows the runtime's FFI", release({ entry: 'js/ffi.py', modules: [py('js/ffi.py')] }), {}, /'js\/ffi\.py'/],
    ["a package that shadows the runtime's SDK", release({ entry: 'workers/__init__.py', modules: [py('workers/__init__.py')] }), {}, /'workers\/__init__\.py'/],
    ['a package that shadows Pyodide', release({ entry: 'pyodide/ffi.py', modules: [py('pyodide/ffi.py')] }), {}, /'pyodide\/ffi\.py'/],
    ["the Python entry's own name", release({ modules: [py('driver_graph/store.py'), py('substrat_store_entry.py')] }), {}, /substrat_store_entry\.py/],
    ["the verifier's name", release({ modules: [py('driver_graph/store.py'), py(STORE_VERIFIER_MODULE)] }), {}, /substrat-store-verify/],
    ["the upload's metadata part", release({ modules: [py('driver_graph/store.py'), py('metadata')] }), {}, /'metadata'/],
    ['a module that climbs out', release({ modules: [py('driver_graph/../store.py')] }), {}, /may not ship/],
    ['a module that is not Python', release({ modules: [py('driver_graph/store.py'), py('driver_graph/data.json')] }), {}, /data\.json/],
    ['a module named twice', release({ modules: [py('driver_graph/store.py'), py('driver_graph/store.py')] }), {}, /twice/],
    ['two packages', release({ modules: [py('driver_graph/store.py'), py('driver_other/x.py')] }), {}, /more than one package/],
    ['an entry that is not one of the modules', release({ entry: 'driver_graph/missing.py' }), {}, /not one of the release's modules/],
    ["the entry's object class as the driver class", release(), { className: STORE_OBJECT_CLASS }, /entry's own object class/],
    ['a class name that is not a Python identifier', release(), { className: 'Graph$Store' }, /not an identifier/],
    ['an empty script name', release(), { script: '' }, /script name/],
    ['one key for both audiences', release(), { platformPublicKeys: [caller.publicKey] }, /both audiences/],
  ] as const)('refuses %s', (_, bad, patch, error) => {
    expect(() => withPythonStoreEntry(bad, { ...options, ...patch })).toThrow(error);
  });
});
