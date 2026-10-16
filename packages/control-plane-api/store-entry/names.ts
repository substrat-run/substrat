/**
 * The names the store entry (#2289) and its uploader share. `entry.ts` imports them, and
 * `tools/store-entry-emit.mts` writes them into the generated module, so the two cannot drift.
 */

/** The entry's module name in the upload. Reserved: a driver release may not ship a module by it (D-63). */
export const STORE_ENTRY_MODULE = 'substrat-store-entry.js';

/**
 * The Python entry's module name in the upload (#2290), the script's main module when the driver
 * is Python. Reserved.
 */
export const STORE_ENTRY_PYTHON_MODULE = 'substrat_store_entry.py';

/**
 * The verifier the Python entry imports: `store-entry/verify.ts`, bundled as an ES module beside
 * it, so both entries run one verifier. Reserved.
 */
export const STORE_VERIFIER_MODULE = 'substrat-store-verify.js';

/**
 * The compatibility date a Python driver's store script is uploaded with. One constant, so the
 * upload and the package's probe cannot run different runtimes.
 */
export const STORE_PYTHON_COMPATIBILITY_DATE = '2026-03-01';

/** The Python runtime's own flag. The upload adds the two that keep the entry's bindings from the driver. */
export const STORE_PYTHON_COMPATIBILITY_FLAGS = ['python_workers'];

/** Every module name the platform's entries own. A driver release may ship none of them (D-63). */
export const STORE_RESERVED_MODULES = [STORE_ENTRY_MODULE, STORE_ENTRY_PYTHON_MODULE, STORE_VERIFIER_MODULE];

/** The import specifier the uploader replaces with `./<the driver module>`. */
export const STORE_DRIVER_PLACEHOLDER = '__SUBSTRAT_STORE_DRIVER__';

/** The class name the uploader replaces, inside a property access on the driver module. */
export const STORE_CLASS_PLACEHOLDER = '__SUBSTRAT_STORE_CLASS__';

/** The object class the entry addresses, and the SQLite class the upload migrates. Reserved. */
export const STORE_OBJECT_CLASS = 'SubstratStoreObject';

/** The binding the entry uses to address that class. */
export const STORE_OBJECT_BINDING = 'SUBSTRAT_STORE';

/** The store script's own name, as the signer writes it into the envelope's `script` line. */
export const STORE_SCRIPT_VAR = 'SUBSTRAT_STORE_SCRIPT';

/** The `caller` audience's public keys: raw Ed25519, base64url, comma-separated. */
export const STORE_CALLER_KEYS_VAR = 'SUBSTRAT_STORE_CALLER_KEYS';

/** The `platform` audience's public keys, in the same form. */
export const STORE_PLATFORM_KEYS_VAR = 'SUBSTRAT_STORE_PLATFORM_KEYS';

/**
 * Every binding the entry owns starts with this. The driver's class is constructed with an env
 * that has none of them, and a driver bundle may not declare one.
 */
export const STORE_RESERVED_BINDING_PREFIX = 'SUBSTRAT_STORE';
