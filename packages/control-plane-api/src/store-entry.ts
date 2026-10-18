import { classifyPythonStoreModule, scopeStorePublicKeysFrom, type DeclaredBinding } from '@substrat-run/contracts';
import type { VerticalBundle } from './deploy.js';
import {
  STORE_CALLER_KEYS_VAR,
  STORE_CLASS_PLACEHOLDER,
  STORE_ENTRY_MODULE,
  STORE_ENTRY_PYTHON_MODULE,
  STORE_ENTRY_PYTHON_SOURCE,
  STORE_ENTRY_PYTHON_VERIFIER_SOURCE,
  STORE_ENTRY_SOURCE,
  STORE_DRIVER_PLACEHOLDER,
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
  STORE_DRIVER_PLACEHOLDER,
  STORE_OBJECT_BINDING,
  STORE_OBJECT_CLASS,
  STORE_PYTHON_COMPATIBILITY_DATE,
  STORE_RESERVED_MODULES,
  STORE_VERIFIER_MODULE,
} from './store-entry.generated.js';

export interface StoreEntryOptions {
  /** The driver class's export name. Replaces the placeholder in the entry. */
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
 * driver module reads every binding of the script that way, the entry's own included, whatever
 * env its class is constructed with. The entry itself reads only the env its handlers are given.
 */
export const STORE_DISALLOW_IMPORTABLE_ENV = 'disallow_importable_env';

/**
 * The compatibility flag that keeps `ctx.exports` off. From compatibility date 2025-11-17 it is
 * on by default, and the driver, which is constructed with the object's `ctx`, would get a
 * loopback to the entry's own object class and default export: the namespace its env was
 * stripped of, by another name. Every call through it would still meet the entry's checks, but
 * the driver has no use for it, so the upload turns it off.
 */
export const STORE_DISABLE_CTX_EXPORTS = 'disable_ctx_exports';

/** The flags a driver release may not set, because each would undo one of the two above. */
const REFUSED_DRIVER_FLAGS = ['allow_importable_env', 'enable_ctx_exports'];

/** An inline config value. The shared binding schema does not carry `text`, so it is cast once here. */
const plainText = (name: string, text: string) => ({ type: 'plain_text', name, text }) as DeclaredBinding;

const encode = (text: string) => new TextEncoder().encode(text);

/** A driver class name the entry can import: an identifier, and not the entry's own class. */
function assertDriverClass(className: string, identifier: RegExp): void {
  if (!identifier.test(className)) throw new Error(`store driver class '${className}' is not an identifier`);
  if (className === STORE_OBJECT_CLASS) {
    throw new Error(`store driver class '${className}' is the entry's own object class`);
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
 * driver module that was the bundle's entry. The object class is added to the SQLite migration,
 * and the script name and both audiences' public keys are bound for the entry, which checks
 * every call before the driver's class is constructed.
 *
 * Refused, before anything is built: a class name that is not an identifier or is the entry's
 * own object class; a bundle entry that is not a plain module name; a bundle that ships a
 * module under one of the platform entries' names (`STORE_RESERVED_MODULES`), declares the
 * entry's class, or declares a binding in the entry's reserved `SUBSTRAT_STORE*` space (D-63);
 * keys `scopeStorePublicKeysFrom` refuses, one key for both audiences included; an empty script
 * name; a compatibility flag that would undo one of the upload's own (`allow_importable_env`,
 * `enable_ctx_exports`).
 *
 * The upload carries `disallow_importable_env` and `disable_ctx_exports`, so the driver reaches
 * the entry's bindings neither through `cloudflare:workers` nor through `ctx.exports`.
 */
export function withStoreEntry<
  B extends Pick<VerticalBundle, 'entry' | 'modules'> &
    Partial<Pick<VerticalBundle, 'doClasses' | 'bindings' | 'compatibilityFlags'>>,
>(bundle: B, options: StoreEntryOptions): B {
  assertDriverClass(options.className, /^[A-Za-z_$][A-Za-z0-9_$]*$/);
  if (!MODULE_NAME.test(bundle.entry) || STORE_RESERVED_MODULES.includes(bundle.entry)) {
    throw new Error(`store driver entry '${bundle.entry}' is not a module name the store entry can import`);
  }
  const reservedModule = bundle.modules.find((module) => STORE_RESERVED_MODULES.includes(module.name));
  if (reservedModule) {
    throw new Error(`a store driver release may not ship a module named '${reservedModule.name}'`);
  }
  if ((bundle.doClasses ?? []).includes(STORE_OBJECT_CLASS)) {
    throw new Error(`a store driver release may not declare the class '${STORE_OBJECT_CLASS}'`);
  }
  const reserved = (bundle.bindings ?? []).find((binding) => binding.name.startsWith(STORE_RESERVED_BINDING_PREFIX));
  if (reserved) {
    throw new Error(`a store driver release may not declare the binding '${reserved.name}'`);
  }
  const refusedFlag = (bundle.compatibilityFlags ?? []).find((flag) => REFUSED_DRIVER_FLAGS.includes(flag));
  if (refusedFlag) {
    throw new Error(`a store driver release may not set '${refusedFlag}'`);
  }
  const entryBindings = storeEntryBindings(options);
  const source = STORE_ENTRY_SOURCE.split(STORE_DRIVER_PLACEHOLDER)
    .join(`./${bundle.entry}`)
    .split(STORE_CLASS_PLACEHOLDER)
    .join(options.className);
  const driver = 'application/javascript+module';
  const bindings: DeclaredBinding[] = [...(bundle.bindings ?? []), ...entryBindings];
  return {
    ...bundle,
    entry: STORE_ENTRY_MODULE,
    modules: [{ name: STORE_ENTRY_MODULE, content: encode(source), contentType: driver }, ...bundle.modules],
    doClasses: [...(bundle.doClasses ?? []), STORE_OBJECT_CLASS],
    compatibilityFlags: [
      ...new Set([...(bundle.compatibilityFlags ?? []), STORE_DISALLOW_IMPORTABLE_ENV, STORE_DISABLE_CTX_EXPORTS]),
    ],
    bindings,
  };
}

/** One release of a Python driver, as the publish flow hands it to the upload. */
export interface PythonStoreDriverRelease {
  /** The module that exports the registered class, for example `driver_graph/store.py`. */
  readonly entry: string;
  readonly modules: readonly { readonly name: string; readonly content: Uint8Array }[];
}

/** The store script for a Python driver, ready to upload: the main module first. */
export interface PythonStoreScript {
  readonly mainModule: string;
  readonly modules: readonly { readonly name: string; readonly content: Uint8Array; readonly contentType: string }[];
  readonly compatibilityDate: string;
  readonly compatibilityFlags: readonly string[];
  readonly bindings: readonly DeclaredBinding[];
}

/**
 * Workers' Data module type. Vendored `python_modules/` files, `.py` included, upload as this:
 * that is the multipart type a Data module uses, and it is what the upload already sends for
 * opaque bytes. The driver's own `.py` modules stay `text/x-python`.
 */
export const STORE_PYTHON_DATA_CONTENT_TYPE = 'application/octet-stream';

/**
 * The store script as uploaded for a Python driver (#2290, #2210). The Python entry is the main
 * module, with the driver's module and class in place of its two placeholders, and the verifier
 * it imports is shipped beside it, so it runs the JavaScript entry's check. The driver's modules
 * follow, byte for byte, and so do its vendored `python_modules/` (#2390), as Data modules. The
 * bindings and the two flags are the JavaScript entry's (`withStoreEntry`), with `python_workers`.
 *
 * The script imports `workers` from the Python workers runtime those flags and
 * {@link STORE_PYTHON_COMPATIBILITY_DATE} select. The release does not ship that SDK.
 *
 * Refused, before anything is built (D-63): a class name that is not a Python identifier or is
 * the entry's own class; a module {@link classifyPythonStoreModule} refuses; modules under more
 * than one `driver_` package; a module named twice; an entry that is not one of the modules, or
 * not a driver module; and whatever `withStoreEntry` refuses of the script name and the keys. A
 * reserved module name is refused again by name.
 */
export function withPythonStoreEntry(release: PythonStoreDriverRelease, options: StoreEntryOptions): PythonStoreScript {
  assertDriverClass(options.className, /^[A-Za-z_][A-Za-z0-9_]*$/);
  assertPythonDriverModules(release);
  const bindings = storeEntryBindings(options);
  const driverModule = release.entry.replace(/\.py$/, '').replaceAll('/', '.');
  const source = STORE_ENTRY_PYTHON_SOURCE.split(STORE_DRIVER_PLACEHOLDER)
    .join(driverModule)
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
      ...release.modules.map((module) => ({
        name: module.name,
        content: module.content,
        contentType: classifyPythonStoreModule(module.name).kind === 'vendored' ? STORE_PYTHON_DATA_CONTENT_TYPE : 'text/x-python',
      })),
    ],
    compatibilityDate: STORE_PYTHON_COMPATIBILITY_DATE,
    compatibilityFlags: [...STORE_PYTHON_COMPATIBILITY_FLAGS, STORE_DISALLOW_IMPORTABLE_ENV, STORE_DISABLE_CTX_EXPORTS],
    bindings,
  };
}

/**
 * The module rule of a Python driver's release (D-63, #2390): one `driver_<package>` of `.py`
 * modules, optionally `python_modules/<path>` beside it, none twice, and the entry one of the
 * driver modules. The upload applies it when a release arrives (#2300), and `withPythonStoreEntry`
 * again before every script it builds.
 */
export function assertPythonDriverModules(release: PythonStoreDriverRelease): void {
  const packages = new Set<string>();
  const names = new Set<string>();
  for (const module of release.modules) {
    if (STORE_RESERVED_MODULES.includes(module.name)) {
      throw new Error(
        `a store driver release may not ship a module named '${module.name}': a driver module is driver_<package>/…/<module>.py, or a dependency is python_modules/<path>`,
      );
    }
    const classified = classifyPythonStoreModule(module.name);
    if (names.has(module.name)) throw new Error(`a store driver release ships '${module.name}' twice`);
    names.add(module.name);
    if (classified.kind === 'driver') packages.add(classified.packageName);
  }
  if (packages.size > 1) {
    throw new Error(`a store driver release ships more than one package (${[...packages].sort().join(', ')})`);
  }
  if (packages.size === 0) throw new Error('a store driver release ships no driver_ package');
  if (!names.has(release.entry)) {
    throw new Error(`store driver entry '${release.entry}' is not one of the release's modules`);
  }
  if (classifyPythonStoreModule(release.entry).kind !== 'driver') {
    throw new Error(`store driver entry '${release.entry}' is not a driver module`);
  }
}
