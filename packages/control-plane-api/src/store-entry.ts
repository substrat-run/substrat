import type { DeclaredBinding } from '@substrat-run/contracts';
import type { VerticalBundle } from './deploy.js';
import {
  STORE_CLASS_PLACEHOLDER,
  STORE_ENTRY_MODULE,
  STORE_ENTRY_SOURCE,
  STORE_KIND_PLACEHOLDER,
  STORE_OBJECT_BINDING,
  STORE_OBJECT_CLASS,
} from './store-entry.generated.js';

export {
  STORE_CLASS_PLACEHOLDER,
  STORE_ENTRY_MODULE,
  STORE_ENTRY_SOURCE,
  STORE_KIND_PLACEHOLDER,
  STORE_OBJECT_BINDING,
  STORE_OBJECT_CLASS,
  STORE_OBJECT_NAME_KEY,
} from './store-entry.generated.js';

export interface StoreEntryOptions {
  /** The kind class's export name. Replaces the placeholder in the entry. */
  readonly className: string;
  /** The vertical this script serves. The envelope's name must name it. */
  readonly vertical: string;
  /** Raw Ed25519 public key, base64url. Audience `caller`. */
  readonly callerPublicKey: string;
  /** Raw Ed25519 public key, base64url. Audience `platform`. */
  readonly platformPublicKey: string;
}

/**
 * The store script as uploaded (#2289). The entry becomes the main module and imports
 * the kind module that was the bundle's entry. The object class is added to the SQLite
 * migration. The kind is constructed only after the envelope and the remembered name check.
 */
export function withStoreEntry<
  B extends Pick<VerticalBundle, 'entry' | 'modules'> & Partial<Pick<VerticalBundle, 'doClasses' | 'bindings'>>,
>(bundle: B, options: StoreEntryOptions): B {
  if (!/^[A-Za-z_$][A-Za-z0-9_$]*$/.test(options.className)) {
    throw new Error(`store kind class '${options.className}' is not an identifier`);
  }
  const encode = (text: string) => new TextEncoder().encode(text);
  const source = STORE_ENTRY_SOURCE.split(STORE_KIND_PLACEHOLDER)
    .join(`./${bundle.entry}`)
    .split(STORE_CLASS_PLACEHOLDER)
    .join(options.className);
  const kind = 'application/javascript+module';
  const own = bundle.modules.filter((module) => module.name !== STORE_ENTRY_MODULE);
  const bindings: DeclaredBinding[] = [
    ...(bundle.bindings ?? []),
    { type: 'durable_object_namespace', name: STORE_OBJECT_BINDING, class_name: STORE_OBJECT_CLASS },
    { type: 'plain_text', name: 'SUBSTRAT_STORE_VERTICAL', text: options.vertical } as DeclaredBinding,
    { type: 'plain_text', name: 'SUBSTRAT_STORE_CALLER_KEY', text: options.callerPublicKey } as DeclaredBinding,
    { type: 'plain_text', name: 'SUBSTRAT_STORE_PLATFORM_KEY', text: options.platformPublicKey } as DeclaredBinding,
  ];
  return {
    ...bundle,
    entry: STORE_ENTRY_MODULE,
    modules: [{ name: STORE_ENTRY_MODULE, content: encode(source), contentType: kind }, ...own],
    doClasses: [...new Set([...(bundle.doClasses ?? []), STORE_OBJECT_CLASS])],
    bindings,
  };
}
