import { scopeStorePublicKeysFrom, type DeclaredBinding } from '@substrat-run/contracts';
import type { VerticalBundle } from './deploy.js';
import {
  STORE_CALLER_KEYS_VAR,
  STORE_CLASS_PLACEHOLDER,
  STORE_ENTRY_MODULE,
  STORE_ENTRY_PYTHON_MODULE,
  STORE_ENTRY_PYTHON_SOURCE,
  STORE_ENTRY_PYTHON_VERIFIER_SOURCE,
  STORE_ENTRY_SOURCE,
  STORE_KIND_PLACEHOLDER,
  STORE_OBJECT_BINDING,
  STORE_OBJECT_CLASS,
  STORE_PLATFORM_KEYS_VAR,
  STORE_PYTHON_COMPATIBILITY_DATE,
  STORE_PYTHON_COMPATIBILITY_FLAGS,
  STORE_RESERVED_BINDING_PREFIX,
  STORE_RESERVED_MODULES,
  STORE_SCRIPT_VAR,
  STORE_VERIFIER_MODULE,
} from './store-entry.generated.js';

export {
  STORE_CLASS_PLACEHOLDER,
  STORE_ENTRY_MODULE,
  STORE_ENTRY_PYTHON_MODULE,
  STORE_ENTRY_PYTHON_SOURCE,
  STORE_ENTRY_PYTHON_VERIFIER_SOURCE,
  STORE_ENTRY_SOURCE,
  STORE_KIND_PLACEHOLDER,
  STORE_OBJECT_BINDING,
  STORE_OBJECT_CLASS,
  STORE_PYTHON_COMPATIBILITY_DATE,
  STORE_RESERVED_MODULES,
  STORE_VERIFIER_MODULE,
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

/**
 * The compatibility flag that keeps `ctx.exports` off. From compatibility date 2025-11-17 it is
 * on by default, and the kind, which is constructed with the object's `ctx`, would get a
 * loopback to the entry's own object class and default export: the namespace its env was
 * stripped of, by another name. Every call through it would still meet the entry's checks, but
 * the kind has no use for it, so the upload turns it off.
 */
export const STORE_DISABLE_CTX_EXPORTS = 'disable_ctx_exports';

/** The flags a kind release may not set, because each would undo one of the two above. */
const REFUSED_KIND_FLAGS = ['allow_importable_env', 'enable_ctx_exports'];

/** An inline config value. The shared binding schema does not carry `text`, so it is cast once here. */
const plainText = (name: string, text: string) => ({ type: 'plain_text', name, text }) as DeclaredBinding;

const encode = (text: string) => new TextEncoder().encode(text);

/** A kind class name the entry can import: an identifier, and not the entry's own class. */
function assertKindClass(className: string, identifier: RegExp): void {
  if (!identifier.test(className)) throw new Error(`store kind class '${className}' is not an identifier`);
  if (className === STORE_OBJECT_CLASS) {
    throw new Error(`store kind class '${className}' is the entry's own object class`);
  }
}

/**
 * The bindings every store entry, JavaScript or Python, is uploaded with: the object namespace,
 * the script's own name and both audiences' public keys. Throws on an empty script name and on
 * keys `scopeStorePublicKeysFrom` refuses, one key for both audiences included.
 */
function storeEntryBindings(options: StoreEntryOptions): DeclaredBinding[] {
  if (options.script.length === 0 || options.script.includes('\n')) {
    throw new Error('a store script name is empty or contains a newline');
  }
  const keys = scopeStorePublicKeysFrom({
    caller: options.callerPublicKeys.join(','),
    platform: options.platformPublicKeys.join(','),
  });
  return [
    { type: 'durable_object_namespace', name: STORE_OBJECT_BINDING, class_name: STORE_OBJECT_CLASS },
    plainText(STORE_SCRIPT_VAR, options.script),
    plainText(STORE_CALLER_KEYS_VAR, keys.caller.join(',')),
    plainText(STORE_PLATFORM_KEYS_VAR, keys.platform.join(',')),
  ];
}

/**
 * The store script as uploaded (#2289). The entry becomes the main module and imports the
 * kind module that was the bundle's entry. The object class is added to the SQLite migration,
 * and the script name and both audiences' public keys are bound for the entry, which checks
 * every call before the kind's class is constructed.
 *
 * Refused, before anything is built: a class name that is not an identifier or is the entry's
 * own object class; a bundle entry that is not a plain module name; a bundle that ships a
 * module under one of the platform entries' names (`STORE_RESERVED_MODULES`), declares the
 * entry's class, or declares a binding in the entry's reserved `SUBSTRAT_STORE*` space (D-63);
 * keys `scopeStorePublicKeysFrom` refuses, one key for both audiences included; an empty script
 * name; a compatibility flag that would undo one of the upload's own (`allow_importable_env`,
 * `enable_ctx_exports`).
 *
 * The upload carries `disallow_importable_env` and `disable_ctx_exports`, so the kind reaches
 * the entry's bindings neither through `cloudflare:workers` nor through `ctx.exports`.
 */
export function withStoreEntry<
  B extends Pick<VerticalBundle, 'entry' | 'modules'> &
    Partial<Pick<VerticalBundle, 'doClasses' | 'bindings' | 'compatibilityFlags'>>,
>(bundle: B, options: StoreEntryOptions): B {
  assertKindClass(options.className, /^[A-Za-z_$][A-Za-z0-9_$]*$/);
  if (!MODULE_NAME.test(bundle.entry) || STORE_RESERVED_MODULES.includes(bundle.entry)) {
    throw new Error(`store kind entry '${bundle.entry}' is not a module name the store entry can import`);
  }
  const reservedModule = bundle.modules.find((module) => STORE_RESERVED_MODULES.includes(module.name));
  if (reservedModule) {
    throw new Error(`a store kind release may not ship a module named '${reservedModule.name}'`);
  }
  if ((bundle.doClasses ?? []).includes(STORE_OBJECT_CLASS)) {
    throw new Error(`a store kind release may not declare the class '${STORE_OBJECT_CLASS}'`);
  }
  const reserved = (bundle.bindings ?? []).find((binding) => binding.name.startsWith(STORE_RESERVED_BINDING_PREFIX));
  if (reserved) {
    throw new Error(`a store kind release may not declare the binding '${reserved.name}'`);
  }
  const refusedFlag = (bundle.compatibilityFlags ?? []).find((flag) => REFUSED_KIND_FLAGS.includes(flag));
  if (refusedFlag) {
    throw new Error(`a store kind release may not set '${refusedFlag}'`);
  }
  const entryBindings = storeEntryBindings(options);
  const source = STORE_ENTRY_SOURCE.split(STORE_KIND_PLACEHOLDER)
    .join(`./${bundle.entry}`)
    .split(STORE_CLASS_PLACEHOLDER)
    .join(options.className);
  const kind = 'application/javascript+module';
  const bindings: DeclaredBinding[] = [...(bundle.bindings ?? []), ...entryBindings];
  return {
    ...bundle,
    entry: STORE_ENTRY_MODULE,
    modules: [{ name: STORE_ENTRY_MODULE, content: encode(source), contentType: kind }, ...bundle.modules],
    doClasses: [...(bundle.doClasses ?? []), STORE_OBJECT_CLASS],
    compatibilityFlags: [
      ...new Set([...(bundle.compatibilityFlags ?? []), STORE_DISALLOW_IMPORTABLE_ENV, STORE_DISABLE_CTX_EXPORTS]),
    ],
    bindings,
  };
}

/** One release of a Python kind, as the publish flow hands it to the upload. */
export interface PythonStoreKindRelease {
  /** The module that exports the registered class, for example `kind_graph/store.py`. */
  readonly entry: string;
  readonly modules: readonly { readonly name: string; readonly content: Uint8Array }[];
}

/** The store script for a Python kind, ready to upload: the main module first. */
export interface PythonStoreScript {
  readonly mainModule: string;
  readonly modules: readonly { readonly name: string; readonly content: Uint8Array; readonly contentType: string }[];
  readonly compatibilityDate: string;
  readonly compatibilityFlags: readonly string[];
  readonly bindings: readonly DeclaredBinding[];
}

/**
 * A Python kind module's path: one top-level package that starts with `kind_`, then
 * identifiers, ending in `.py`. The prefix keeps a kind's modules off every name the Python
 * entry imports or the runtime provides (`workers`, `js`, `pyodide`, the entry, its verifier),
 * and off `metadata`, the upload's own form part.
 */
const PYTHON_KIND_MODULE = /^(kind_[a-z0-9_]+)(?:\/[A-Za-z_][A-Za-z0-9_]*)*\/[A-Za-z_][A-Za-z0-9_]*\.py$/;

/**
 * The store script as uploaded for a Python kind (#2290, #2210). The Python entry is the main
 * module, with the kind's module and class in place of its two placeholders, and the verifier
 * it imports is shipped beside it, so it runs the JavaScript entry's check. The kind's modules
 * follow, byte for byte. The bindings and the two flags are the JavaScript entry's
 * (`withStoreEntry`), with `python_workers`.
 *
 * Refused, before anything is built (D-63): a class name that is not a Python identifier or is
 * the entry's own class; a module that is not `kind_<package>/…/<module>.py`; modules under more
 * than one package; a module named twice; an entry that is not one of the modules; and
 * whatever `withStoreEntry` refuses of the script name and the keys. A reserved module name
 * cannot pass the path rule, and is refused again by name.
 */
export function withPythonStoreEntry(release: PythonStoreKindRelease, options: StoreEntryOptions): PythonStoreScript {
  assertKindClass(options.className, /^[A-Za-z_][A-Za-z0-9_]*$/);
  const packages = new Set<string>();
  const names = new Set<string>();
  for (const module of release.modules) {
    const path = PYTHON_KIND_MODULE.exec(module.name);
    if (!path || STORE_RESERVED_MODULES.includes(module.name)) {
      throw new Error(`a store kind release may not ship a module named '${module.name}': a kind module is kind_<package>/…/<module>.py`);
    }
    if (names.has(module.name)) throw new Error(`a store kind release ships '${module.name}' twice`);
    names.add(module.name);
    packages.add(path[1]!);
  }
  if (packages.size > 1) {
    throw new Error(`a store kind release ships more than one package (${[...packages].sort().join(', ')})`);
  }
  if (!names.has(release.entry)) {
    throw new Error(`store kind entry '${release.entry}' is not one of the release's modules`);
  }
  const bindings = storeEntryBindings(options);
  const kindModule = release.entry.replace(/\.py$/, '').replaceAll('/', '.');
  const source = STORE_ENTRY_PYTHON_SOURCE.split(STORE_KIND_PLACEHOLDER)
    .join(kindModule)
    .split(STORE_CLASS_PLACEHOLDER)
    .join(options.className);
  return {
    mainModule: STORE_ENTRY_PYTHON_MODULE,
    modules: [
      { name: STORE_ENTRY_PYTHON_MODULE, content: encode(source), contentType: 'text/x-python' },
      {
        name: STORE_VERIFIER_MODULE,
        content: encode(STORE_ENTRY_PYTHON_VERIFIER_SOURCE),
        contentType: 'application/javascript+module',
      },
      ...release.modules.map((module) => ({ name: module.name, content: module.content, contentType: 'text/x-python' })),
    ],
    compatibilityDate: STORE_PYTHON_COMPATIBILITY_DATE,
    compatibilityFlags: [...STORE_PYTHON_COMPATIBILITY_FLAGS, STORE_DISALLOW_IMPORTABLE_ENV, STORE_DISABLE_CTX_EXPORTS],
    bindings,
  };
}
