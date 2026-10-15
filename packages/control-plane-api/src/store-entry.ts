import { scopeStorePublicKeysFrom, type DeclaredBinding } from '@substrat-run/contracts';
import type { VerticalBundle } from './deploy.js';
import {
  STORE_CALLER_KEYS_VAR,
  STORE_CLASS_PLACEHOLDER,
  STORE_ENTRY_MODULE,
  STORE_ENTRY_SOURCE,
  STORE_KIND_PLACEHOLDER,
  STORE_OBJECT_BINDING,
  STORE_OBJECT_CLASS,
  STORE_PLATFORM_KEYS_VAR,
  STORE_RESERVED_BINDING_PREFIX,
  STORE_SCRIPT_VAR,
} from './store-entry.generated.js';

export {
  STORE_CLASS_PLACEHOLDER,
  STORE_ENTRY_MODULE,
  STORE_ENTRY_SOURCE,
  STORE_KIND_PLACEHOLDER,
  STORE_OBJECT_BINDING,
  STORE_OBJECT_CLASS,
} from './store-entry.generated.js';

export interface StoreEntryOptions {
  /** The kind class's export name. Replaces the placeholder in the entry. */
  readonly className: string;
  /**
   * This store script's name, as the signers write it into the envelope's `script` line
   * (`scopeStoreScriptName`). Compared as an opaque string; nothing here parses it.
   */
  readonly script: string;
  /** Raw Ed25519 public keys, base64url, audience `caller`. A list, so a key can rotate. */
  readonly callerPublicKeys: readonly string[];
  /** Raw Ed25519 public keys, base64url, audience `platform`. Never one of the caller's. */
  readonly platformPublicKeys: readonly string[];
}

/** A module name the uploader can write and the entry can import: relative, no `..`, JavaScript. */
const MODULE_NAME = /^(?!.*\.\.)[A-Za-z0-9_][A-Za-z0-9_./-]*\.m?js$/;

/**
 * The compatibility flag that empties `import { env } from 'cloudflare:workers'`. Without it a
 * kind module reads every binding of the script that way, the entry's own included, whatever
 * env its class is constructed with. The entry itself reads only the env its handlers are given.
 */
export const STORE_DISALLOW_IMPORTABLE_ENV = 'disallow_importable_env';

/** An inline config value. The shared binding schema does not carry `text`, so it is cast once here. */
const plainText = (name: string, text: string) => ({ type: 'plain_text', name, text }) as DeclaredBinding;

/**
 * The store script as uploaded (#2289). The entry becomes the main module and imports the
 * kind module that was the bundle's entry. The object class is added to the SQLite migration,
 * and the script name and both audiences' public keys are bound for the entry, which checks
 * every call before the kind's class is constructed.
 *
 * Refused, before anything is built: a class name that is not an identifier or is the entry's
 * own object class; a bundle entry that is not a plain module name; a bundle that ships a
 * module under the entry's name, declares the entry's class, or declares a binding in the
 * entry's reserved `SUBSTRAT_STORE*` space (D-63); keys `scopeStorePublicKeysFrom` refuses,
 * one key for both audiences included; an empty script name; a compatibility flag that
 * would give the kind's module the script's env again (`allow_importable_env`).
 *
 * The upload carries `disallow_importable_env`, so the kind cannot read the entry's bindings
 * through `cloudflare:workers` either.
 */
export function withStoreEntry<
  B extends Pick<VerticalBundle, 'entry' | 'modules'> &
    Partial<Pick<VerticalBundle, 'doClasses' | 'bindings' | 'compatibilityFlags'>>,
>(bundle: B, options: StoreEntryOptions): B {
  if (!/^[A-Za-z_$][A-Za-z0-9_$]*$/.test(options.className)) {
    throw new Error(`store kind class '${options.className}' is not an identifier`);
  }
  if (options.className === STORE_OBJECT_CLASS) {
    throw new Error(`store kind class '${options.className}' is the entry's own object class`);
  }
  if (!MODULE_NAME.test(bundle.entry) || bundle.entry === STORE_ENTRY_MODULE) {
    throw new Error(`store kind entry '${bundle.entry}' is not a module name the store entry can import`);
  }
  if (bundle.modules.some((module) => module.name === STORE_ENTRY_MODULE)) {
    throw new Error(`a store kind release may not ship a module named '${STORE_ENTRY_MODULE}'`);
  }
  if ((bundle.doClasses ?? []).includes(STORE_OBJECT_CLASS)) {
    throw new Error(`a store kind release may not declare the class '${STORE_OBJECT_CLASS}'`);
  }
  const reserved = (bundle.bindings ?? []).find((binding) => binding.name.startsWith(STORE_RESERVED_BINDING_PREFIX));
  if (reserved) {
    throw new Error(`a store kind release may not declare the binding '${reserved.name}'`);
  }
  if ((bundle.compatibilityFlags ?? []).includes('allow_importable_env')) {
    throw new Error("a store kind release may not set 'allow_importable_env'");
  }
  if (options.script.length === 0 || options.script.includes('\n')) {
    throw new Error('a store script name is empty or contains a newline');
  }
  const keys = scopeStorePublicKeysFrom({
    caller: options.callerPublicKeys.join(','),
    platform: options.platformPublicKeys.join(','),
  });
  const encode = (text: string) => new TextEncoder().encode(text);
  const source = STORE_ENTRY_SOURCE.split(STORE_KIND_PLACEHOLDER)
    .join(`./${bundle.entry}`)
    .split(STORE_CLASS_PLACEHOLDER)
    .join(options.className);
  const kind = 'application/javascript+module';
  const bindings: DeclaredBinding[] = [
    ...(bundle.bindings ?? []),
    { type: 'durable_object_namespace', name: STORE_OBJECT_BINDING, class_name: STORE_OBJECT_CLASS },
    plainText(STORE_SCRIPT_VAR, options.script),
    plainText(STORE_CALLER_KEYS_VAR, keys.caller.join(',')),
    plainText(STORE_PLATFORM_KEYS_VAR, keys.platform.join(',')),
  ];
  return {
    ...bundle,
    entry: STORE_ENTRY_MODULE,
    modules: [{ name: STORE_ENTRY_MODULE, content: encode(source), contentType: kind }, ...bundle.modules],
    doClasses: [...(bundle.doClasses ?? []), STORE_OBJECT_CLASS],
    compatibilityFlags: [...new Set([...(bundle.compatibilityFlags ?? []), STORE_DISALLOW_IMPORTABLE_ENV])],
    bindings,
  };
}
