import { storeKindReleaseDigest, type ScopeStoreNeed, type StoreKindRegistration } from '@substrat-run/contracts';
import { ControlPlaneError } from '@substrat-run/control-plane-client';
import { scopeStoreUploadPlan } from './deploy.js';
import { STORE_OBJECT_CLASS, STORE_RESERVED_BINDING_PREFIX } from './store-entry.generated.js';
import { withPythonStoreEntry, type PythonStoreKindRelease, type PythonStoreScript } from './store-entry.js';

/**
 * The binding that records which pinned release a store script runs: the release bundle's
 * sha256 (D-63). In the entry's reserved prefix, so the kind's env never carries it.
 */
export const STORE_RELEASE_VAR = `${STORE_RESERVED_BINDING_PREFIX}_RELEASE`;

/**
 * The binding that records what else the script was built from: a digest over every module the
 * upload sent and its configuration. A changed entry, verifier, key list or flag changes it.
 */
export const STORE_BUILD_VAR = `${STORE_RESERVED_BINDING_PREFIX}_BUILD`;

/** One release of a kind's code, as the publish flow stores it (#2297). */
export interface StoreKindReleaseArtifact extends PythonStoreKindRelease {
  /** The commit the bundle was built from. A reviewer reads it; the upload checks the sha256. */
  readonly sourceCommit: string;
}

export interface ScopeStoreEnsurerOptions {
  accountId: string;
  namespace: string;
  apiToken: string;
  /** The `caller` audience's public keys, raw Ed25519, base64url. A list, so a key can rotate. */
  callerPublicKeys: readonly string[];
  /** The `platform` audience's public keys, in the same form. Never one of the caller's. */
  platformPublicKeys: readonly string[];
  kinds?: readonly StoreKindRegistration[];
  /**
   * A release's bytes. With `sha256`, that release, which the script already runs. Without it,
   * the release the publish flow rolled out to this vertical last (#2297). Undefined when there
   * is none.
   */
  loadRelease: (input: {
    readonly kind: string;
    readonly vertical: string;
    readonly sha256?: string;
  }) => Promise<StoreKindReleaseArtifact | undefined>;
}

/** Everything the upload sends, as one digest, so a script built from anything else differs. */
async function buildDigest(script: PythonStoreScript): Promise<string> {
  const { modules, ...config } = script;
  const named = modules.map((module) => ({ name: `module/${module.name}/${module.contentType}`, content: module.content }));
  return storeKindReleaseDigest({
    entry: named[0]!.name,
    modules: [...named, { name: 'config', content: new TextEncoder().encode(JSON.stringify(config)) }],
  });
}

/**
 * Put every (kind, vertical) store script a vertical's stores need in place, before the
 * vertical's own upload (#2210, D-63). A push or a serve never moves a script to another
 * release: only the publish flow and its rollback do (#2297).
 *
 * - No script yet: it is uploaded at the release the publish flow rolled out to this vertical.
 * - A script: it is rebuilt at the release it already runs, and uploaded again only when what
 *   it was built from changed (the platform's entry, the verifier, a key list, a flag), so a
 *   fix or a key rotation reaches it without a release moving.
 *
 * Every upload hashes the module bytes it is about to send and refuses (422) bytes whose
 * sha256 the kind's registration does not pin, or that are not the release asked for. A kind
 * with no release to run is refused (409). The runtime's own failures are 502.
 */
export function createScopeStoreEnsurer(opts: ScopeStoreEnsurerOptions) {
  const scriptUrl = (name: string) =>
    `https://api.cloudflare.com/client/v4/accounts/${opts.accountId}` +
    `/workers/dispatch/namespaces/${opts.namespace}/scripts/${encodeURIComponent(name)}`;

  return async (input: { vertical: string; stores: readonly ScopeStoreNeed[] }): Promise<void> => {
    const plan = scopeStoreUploadPlan({ vertical: input.vertical, stores: input.stores, kinds: opts.kinds });
    for (const script of plan.scripts) {
      const current = await recorded(scriptUrl(script.scriptName));
      if (current.exists && !current.release) {
        // Not an upload of this code. Which release it runs cannot be told, so it is not guessed.
        throw new ControlPlaneError(409, `store script '${script.scriptName}' records no release`);
      }
      const release = await opts.loadRelease({
        kind: script.kind,
        vertical: script.vertical,
        ...(current.release ? { sha256: current.release } : {}),
      });
      if (!release) {
        throw new ControlPlaneError(
          409,
          current.release
            ? `kind '${script.kind}' release ${current.release} is not stored`
            : `kind '${script.kind}' has no release rolled out to '${script.vertical}'`,
        );
      }
      // The bytes about to be sent, copied once and hashed now: never a hash taken when they
      // arrived (D-63). The copy is what is built from and sent, so the hashed bytes are the
      // sent bytes whatever the loader keeps or shares.
      const loaded: PythonStoreKindRelease = {
        entry: release.entry,
        modules: release.modules.map((module) => ({ name: module.name, content: new Uint8Array(module.content) })),
      };
      const sha256 = await storeKindReleaseDigest(loaded).catch((e: unknown) => {
        throw new ControlPlaneError(422, e instanceof Error ? e.message : String(e));
      });
      if (current.release && sha256 !== current.release) {
        throw new ControlPlaneError(422, `kind '${script.kind}' release ${current.release} loaded as other bytes (${sha256})`);
      }
      if (!script.releases.some((pin) => pin.sha256 === sha256)) {
        throw new ControlPlaneError(422, `kind '${script.kind}' release ${sha256} is not pinned in its registration`);
      }
      let built: PythonStoreScript;
      try {
        built = withPythonStoreEntry(loaded, {
          className: script.className,
          script: script.scriptName,
          callerPublicKeys: opts.callerPublicKeys,
          platformPublicKeys: opts.platformPublicKeys,
        });
      } catch (e) {
        throw new ControlPlaneError(422, e instanceof Error ? e.message : String(e));
      }
      const build = await buildDigest(built);
      if (current.exists && current.build === build) continue;
      await put(scriptUrl(script.scriptName), script.scriptName, built, { sha256, build, first: !current.exists });
    }
  };

  async function recorded(url: string): Promise<{ exists: boolean; release?: string; build?: string }> {
    const res = await fetch(`${url}/settings`, { headers: { authorization: `Bearer ${opts.apiToken}` } });
    if (res.status === 404) return { exists: false };
    if (!res.ok) throw new ControlPlaneError(502, `store script settings failed (${res.status})`);
    const body = (await res.json()) as { result?: { bindings?: { name?: string; text?: string }[] } };
    const text = (name: string) => body.result?.bindings?.find((b) => b.name === name)?.text;
    return { exists: true, release: text(STORE_RELEASE_VAR), build: text(STORE_BUILD_VAR) };
  }

  async function put(
    url: string,
    scriptName: string,
    built: PythonStoreScript,
    upload: { sha256: string; build: string; first: boolean },
  ): Promise<void> {
    const metadata = {
      main_module: built.mainModule,
      compatibility_date: built.compatibilityDate,
      compatibility_flags: built.compatibilityFlags,
      bindings: [
        ...built.bindings,
        { type: 'plain_text', name: STORE_RELEASE_VAR, text: upload.sha256 },
        { type: 'plain_text', name: STORE_BUILD_VAR, text: upload.build },
      ],
      // The first upload declares the object class. Two pushes that both find no script both
      // send this tag; the second is refused by the runtime (502), and a retry finds the script.
      ...(upload.first ? { migrations: { new_tag: 'v1', new_sqlite_classes: [STORE_OBJECT_CLASS] } } : {}),
    };
    const form = new FormData();
    form.set('metadata', new Blob([JSON.stringify(metadata)], { type: 'application/json' }), 'metadata.json');
    for (const module of built.modules) {
      // Sent as built, not copied again: every module is the ensurer's own copy or the entry's
      // own encoding, so its buffer is an ArrayBuffer, and these are the bytes that were hashed.
      form.set(module.name, new Blob([module.content as Uint8Array<ArrayBuffer>], { type: module.contentType }), module.name);
    }
    const res = await fetch(url, { method: 'PUT', headers: { authorization: `Bearer ${opts.apiToken}` }, body: form });
    if (!res.ok) throw new ControlPlaneError(502, `store script upload failed (${res.status}) for '${scriptName}'`);
  }
}
