/**
 * The names the store entry (#2289) and its uploader share. `entry.ts` imports them, and
 * `tools/store-entry-emit.mts` writes them into the generated module, so the two cannot drift.
 */

/** The entry's module name in the upload. Reserved: a kind release may not ship a module by it (D-63). */
export const STORE_ENTRY_MODULE = 'substrat-store-entry.js';

/** The import specifier the uploader replaces with `./<the kind module>`. */
export const STORE_KIND_PLACEHOLDER = '__SUBSTRAT_STORE_KIND__';

/** The class name the uploader replaces, inside a property access on the kind module. */
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
 * Every binding the entry owns starts with this. The kind's class is constructed with an env
 * that has none of them, and a kind bundle may not declare one.
 */
export const STORE_RESERVED_BINDING_PREFIX = 'SUBSTRAT_STORE';
