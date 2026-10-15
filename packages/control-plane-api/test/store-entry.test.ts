import { describe, expect, it } from 'vitest';
import { generateScopeStoreKeyPair } from '@substrat-run/contracts/scope-store-envelope';
import {
  STORE_CLASS_PLACEHOLDER,
  STORE_ENTRY_MODULE,
  STORE_KIND_PLACEHOLDER,
  STORE_OBJECT_BINDING,
  STORE_OBJECT_CLASS,
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
    ['a kind entry that is not JavaScript', kindBundle({ entry: 'kind.wasm' }), {}, /not a module name/],
    ["the entry's object class", kindBundle({ doClasses: [STORE_OBJECT_CLASS] }), {}, /may not declare the class/],
    ["the entry's class as the kind class", kindBundle(), { className: STORE_OBJECT_CLASS }, /entry's own object class/],
    ['a class name that is not an identifier', kindBundle(), { className: 'Kind; evil()' }, /not an identifier/],
    ['a reserved binding', kindBundle({ bindings: [{ type: 'plain_text', name: 'SUBSTRAT_STORE_CALLER_KEYS' }] }), {}, /may not declare the binding/],
    ['an empty script name', kindBundle(), { script: '' }, /script name/],
  ] as const)('refuses %s', (_, bundle, patch, error) => {
    expect(() => withStoreEntry(bundle, { ...options, ...patch })).toThrow(error);
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
