import {
  base64UrlToBytes,
  type ScopeStoreNeed,
  type StoreKindRegistration,
} from '@substrat-run/contracts';
import { ControlPlaneError } from '@substrat-run/control-plane-client';
import { scopeStoreUploadPlan } from './deploy.js';
import {
  STORE_ENTRY_PYTHON_SOURCE,
  STORE_OBJECT_BINDING,
  STORE_OBJECT_CLASS,
} from './store-entry.generated.js';

/** The entry module an upload sends as `main_module`. The kind's files sit beside it. */
export const STORE_SCRIPT_ENTRY = 'substrat_store_entry.py';

const PYTHON_TYPE = 'text/x-python';
const IDENT = /^[A-Za-z_][A-Za-z0-9_]*$/;
const RELEASE_BINDING = 'SUBSTRAT_STORE_RELEASE';

/** One published release of a kind: the class's module and the modules it imports. */
export interface StoreKindReleaseArtifact {
  readonly release: string;
  /** The module that exports the registered class, for example `kind_counter.py`. */
  readonly entry: string;
  readonly modules: readonly { readonly name: string; readonly content: Uint8Array }[];
}

export interface ScopeStoreEnsurerOptions {
  accountId: string;
  namespace: string;
  apiToken: string;
  /** Raw Ed25519 public key, base64url. Audience `caller`. */
  callerPublicKey: string;
  /** Raw Ed25519 public key, base64url. Audience `platform`. */
  platformPublicKey: string;
  kinds?: readonly StoreKindRegistration[];
  /** The kind's current release. Undefined means none has been published. */
  loadRelease: (kind: string) => Promise<StoreKindReleaseArtifact | undefined>;
}

/** The raw public half of a PKCS8 Ed25519 private key. The script verifies; it never signs. */
export async function ed25519PublicKey(pkcs8: string): Promise<string> {
  const decoded = base64UrlToBytes(pkcs8);
  if (!decoded) throw new ControlPlaneError(503, 'the platform store key is not a base64url PKCS8 key');
  const raw = new Uint8Array(decoded.byteLength);
  raw.set(decoded);
  const key = await crypto.subtle.importKey('pkcs8', raw, { name: 'Ed25519' }, true, ['sign']);
  const jwk = await crypto.subtle.exportKey('jwk', key);
  if (!jwk.x) throw new ControlPlaneError(503, 'the platform store key has no public half');
  return jwk.x;
}

function kindImport(source: string, moduleName: string, className: string): string {
  const line = `from ${moduleName} import ${className} as StoreKind`;
  const replaced = source.replace(/^from \S+ import \S+ as StoreKind$/m, line);
  if (replaced === source) {
    throw new ControlPlaneError(500, 'the Python store entry has no kind import to replace');
  }
  return replaced;
}

/**
 * Upload each (kind, vertical) store script at the kind's current release, before the
 * vertical's own upload (#2210). A script already at that release is left in place. The
 * first upload migrates `SubstratStoreObject`; a later release does not re-declare it.
 */
export function createScopeStoreEnsurer(opts: ScopeStoreEnsurerOptions) {
  const scriptUrl = (name: string) =>
    `https://api.cloudflare.com/client/v4/accounts/${opts.accountId}` +
    `/workers/dispatch/namespaces/${opts.namespace}/scripts/${encodeURIComponent(name)}`;

  return async (input: {
    vertical: string;
    stores: readonly ScopeStoreNeed[];
    /** This publish's bytes. A push omits it and the current release is loaded. */
    release?: StoreKindReleaseArtifact;
  }): Promise<void> => {
    const plan = scopeStoreUploadPlan({ vertical: input.vertical, stores: input.stores, kinds: opts.kinds });
    for (const script of plan.scripts) {
      const release = input.release ?? (await opts.loadRelease(script.kind));
      if (!release) {
        throw new ControlPlaneError(409, `kind '${script.kind}' has no published release`);
      }
      const current = await currentRelease(scriptUrl(script.scriptName));
      if (current.release === release.release) continue;
      await putScript(scriptUrl(script.scriptName), script, release, !current.exists);
    }
  };

  async function currentRelease(url: string): Promise<{ exists: boolean; release?: string }> {
    const res = await fetch(`${url}/settings`, { headers: { authorization: `Bearer ${opts.apiToken}` } });
    if (res.status === 404) return { exists: false };
    if (!res.ok) {
      throw new ControlPlaneError(502, `store script settings failed (${res.status})`);
    }
    const body = (await res.json()) as { result?: { bindings?: { name?: string; text?: string }[] } };
    return { exists: true, release: body.result?.bindings?.find((b) => b.name === RELEASE_BINDING)?.text };
  }

  async function putScript(
    url: string,
    script: { vertical: string; className: string; scriptName: string },
    release: StoreKindReleaseArtifact,
    first: boolean,
  ): Promise<void> {
    const stem = release.entry.replace(/\.py$/, '');
    if (!IDENT.test(stem) || !IDENT.test(script.className)) {
      throw new ControlPlaneError(422, `kind module '${release.entry}' or class '${script.className}' is not an identifier`);
    }
    const modules = [
      { name: STORE_SCRIPT_ENTRY, content: kindImport(STORE_ENTRY_PYTHON_SOURCE, stem, script.className) },
      ...release.modules.map((m) => ({ name: m.name, content: new TextDecoder().decode(m.content) })),
    ];
    if (modules.some((m) => m.name === STORE_SCRIPT_ENTRY && m !== modules[0])) {
      throw new ControlPlaneError(422, `a kind module is named ${STORE_SCRIPT_ENTRY}`);
    }
    const metadata = {
      main_module: STORE_SCRIPT_ENTRY,
      compatibility_date: '2026-03-01',
      compatibility_flags: ['python_workers'],
      bindings: [
        { type: 'durable_object_namespace', name: STORE_OBJECT_BINDING, class_name: STORE_OBJECT_CLASS },
        { type: 'plain_text', name: 'SUBSTRAT_STORE_VERTICAL', text: script.vertical },
        { type: 'plain_text', name: 'SUBSTRAT_STORE_CALLER_KEY', text: opts.callerPublicKey },
        { type: 'plain_text', name: 'SUBSTRAT_STORE_PLATFORM_KEY', text: opts.platformPublicKey },
        { type: 'plain_text', name: RELEASE_BINDING, text: release.release },
      ],
      ...(first ? { migrations: { new_tag: 'v1', new_sqlite_classes: [STORE_OBJECT_CLASS] } } : {}),
    };
    const form = new FormData();
    form.set('metadata', new Blob([JSON.stringify(metadata)], { type: 'application/json' }), 'metadata.json');
    for (const m of modules) {
      form.set(m.name, new Blob([m.content], { type: PYTHON_TYPE }), m.name);
    }
    const res = await fetch(url, { method: 'PUT', headers: { authorization: `Bearer ${opts.apiToken}` }, body: form });
    if (!res.ok) {
      throw new ControlPlaneError(502, `store script upload failed (${res.status}) for '${script.scriptName}'`);
    }
  }
}

