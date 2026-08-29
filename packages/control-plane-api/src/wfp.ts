import { assetHash } from '@substrat-run/contracts';
import { DeployUploadError, nextMigrationTag } from './deploy.js';
import type {
  AssetUpload,
  DeployVerticalFn,
  FetchVerticalModulesFn,
  RecoverAssetContentFn,
  VerticalBundle,
} from './deploy.js';

/**
 * Bound a (potentially large, untrusted) upstream error body before it rides inside a
 * thrown Error and a JSON response — but mark the cut EXPLICITLY. The old bare
 * `.slice(0, 400)` ended mid-token (`…eka/set-budg`) with no sign anything was omitted,
 * so a reader could not tell a real operation name from a severed string, nor that the
 * rest of the list existed (#307). A generous cap keeps an unbounded body from flooding
 * the log while the marker states exactly how much was dropped.
 */
export function clip(body: string, max = 2000): string {
  return body.length <= max ? body : `${body.slice(0, max)} … [truncated, ${body.length - max} chars omitted]`;
}

/**
 * A `DeployVerticalFn` that uploads a bundle into a Workers-for-Platforms **dispatch
 * namespace** (orchestration.md §5.2). It is pure web-standard `fetch` + `FormData` —
 * no Cloudflare SDK, no node built-ins — so it runs unchanged in a Worker (the control
 * plane holds the token as a secret) or in node (the dev server, tests against a real
 * namespace). The multipart shape is exactly what `wrangler deploy` sends and what the
 * K-28 spike verified.
 */
export interface WfpUploaderOptions {
  accountId: string;
  namespace: string;
  /** A Cloudflare API token with Workers Scripts / dispatch write. Platform-held. */
  apiToken: string;
  /**
   * Platform-owned secrets injected as `secret_text` bindings on every pushed script —
   * the ambient credentials a vertical needs to VERIFY inbound platform/router calls
   * (`PLATFORM_SECRET` for `/internal/provision`, K-31; `ROUTER_SECRET` for the routed
   * node, K-27). The vertical does not declare these (they'd fail the §4 sandbox check
   * with no value to give); the platform provides them at deploy from its own env.
   * Names with an undefined/empty value are skipped.
   */
  injectSecrets?: Record<string, string | undefined>;
  /**
   * Bind Workers AI (`env.AI`) on every pushed script (#1054).
   *
   * Deliberately a BINDING and not a credential. The alternative was injecting a Workers
   * AI token as one more `secret_text`, and a pushed vertical can read those: the push
   * gate checks DECLARED bindings, never the code, so R2's ban on `cloudflare:workers`
   * — what stops module code reaching ambient `env` — is not enforced here (#862). A
   * spending credential under that hole is not something to ship; a binding leaves
   * nothing to read, and Workers AI bills the account owning the script, which is ours.
   *
   * Verified on TEST rather than inferred (D-58's discipline): a throwaway
   * dispatch-namespace script accepted `{type:'ai',name:'AI'}`, read back as
   * `{name:'AI',project:'<catalog>',type:'ai'}`, and ran inference through it — with and
   * without a gateway id, reporting real prompt/completion token counts.
   *
   * The honest limit: this is a CAPABILITY the vertical holds, so a vertical can call
   * `env.AI.run()` on our account without passing our gateway id, unattributed. Bounded
   * to Workers AI and cheaper to bound further (gateway spend limits); the durable fix is
   * running inference platform-side, which is what BYOK needs anyway.
   */
  bindAi?: boolean;
  /**
   * Head sampling rate (0–1) for Workers **automatic tracing** on pushed scripts (#858).
   * Absent ⇒ no `traces` block, which is what every push has sent until now.
   *
   * Separate from `observability.enabled` because Cloudflare says it is: *"While automatic
   * tracing is in early beta, this setting will not enable tracing by default, and will only
   * enable logs."* So the `enabled: true` below has been buying logs and nothing else, and a
   * `traces` block is the only thing that turns spans on.
   *
   * A **rate rather than a boolean** on purpose. Tracing instruments every I/O operation, each
   * span is one observability event sharing quota with Workers Logs, and beta pricing ends
   * 2026-10-01 — so the fleet-wide question was never "on or off" but "how much", and a dial
   * lets TEST run at 1 while prod stays dark or samples. Undefined and 0 are NOT the same:
   * undefined omits the block, 0 declares tracing and samples none of it.
   *
   * Why this is worth the option at all: the DO-originated subrequests D-46 documents as
   * unenforceable are also, today, unobservable — and `durable_object_subrequest` spans are
   * the first mechanism that sees them.
   */
  traceSampling?: number;
}

/** Bytes → base64, web-standard only (chunked so a large file does not blow the
 *  `String.fromCharCode` argument limit). The asset upload endpoint takes base64 bodies. */
function toBase64(bytes: Uint8Array): string {
  let binary = '';
  const CHUNK = 0x8000;
  for (let i = 0; i < bytes.length; i += CHUNK) {
    binary += String.fromCharCode(...bytes.subarray(i, i + CHUNK));
  }
  return btoa(binary);
}

/** The Cloudflare `assets.config` block, from our substrate-vocabulary routing fields. */
function assetConfigOf(assets: NonNullable<VerticalBundle['assets']>): Record<string, unknown> {
  return {
    ...(assets.htmlHandling ? { html_handling: assets.htmlHandling } : {}),
    ...(assets.notFoundHandling ? { not_found_handling: assets.notFoundHandling } : {}),
    ...(assets.runWorkerFirst !== undefined ? { run_worker_first: assets.runWorkerFirst } : {}),
  };
}

/**
 * Run Cloudflare's three-step **assets upload session** for a dispatch-namespace script and
 * return the completion JWT the script PUT declares (#340). Static assets are not a binding:
 * they go up their own path, and the script upload only ever names the token this produces.
 *
 * 1. POST the manifest (`path → { hash, size }`) to the script's `assets-upload-session`.
 *    Cloudflare answers with a session JWT and the BUCKETS of hashes it does not already
 *    hold — content-addressed storage, deduped PER SCRIPT (#578: not namespace-wide, however
 *    much the endpoint's shape suggests it), so an unchanged re-deploy of the SAME script
 *    comes back with nothing to upload, but the same manifest against a different script
 *    starts empty-handed.
 * 2. POST each bucket's files, base64, one part per hash, each carrying the Content-Type the
 *    file will be SERVED with. The response to the last bucket carries the completion JWT.
 * 3. (caller) name that JWT in the script metadata's `assets` block.
 *
 * Empty buckets ⇒ every file was already stored and the SESSION jwt is itself the completion
 * token. A promote re-runs this against the stable serving script with the retained manifest
 * and no bytes, which per-script dedupe only satisfies for content that script has served
 * before — anything else (every first serve of new content) is recovered on demand through
 * `recover`, verified against its content-address, and uploaded. When even recovery cannot
 * supply the bytes, this refuses loudly — a script deployed with an incomplete asset set
 * would serve a half-broken page and look like a successful deploy.
 */
async function uploadAssets(
  opts: Pick<WfpUploaderOptions, 'accountId' | 'namespace' | 'apiToken'>,
  scriptName: string,
  files: AssetUpload[],
  recover?: RecoverAssetContentFn,
): Promise<string> {
  const manifest: Record<string, { hash: string; size: number }> = {};
  const byHash = new Map<string, AssetUpload>();
  for (const f of files) {
    manifest[f.path] = { hash: f.hash, size: f.size };
    byHash.set(f.hash, f);
  }

  const sessionUrl =
    `https://api.cloudflare.com/client/v4/accounts/${opts.accountId}` +
    `/workers/dispatch/namespaces/${opts.namespace}/scripts/${encodeURIComponent(scriptName)}/assets-upload-session`;
  const session = await fetch(sessionUrl, {
    method: 'POST',
    headers: { authorization: `Bearer ${opts.apiToken}`, 'content-type': 'application/json' },
    body: JSON.stringify({ manifest }),
  });
  if (!session.ok) {
    const body = await session.text().catch(() => '');
    throw new DeployUploadError(
      session.status,
      `WfP asset session failed (${session.status}) for '${scriptName}': ${clip(body)}`,
    );
  }
  const parsed = (await session.json().catch(() => ({}))) as {
    result?: { jwt?: string; buckets?: string[][] };
  };
  const sessionJwt = parsed.result?.jwt;
  if (!sessionJwt) {
    throw new DeployUploadError(502, `WfP asset session for '${scriptName}' returned no jwt`);
  }
  const buckets = (parsed.result?.buckets ?? []).filter((b) => b.length > 0);
  if (buckets.length === 0) return sessionJwt; // nothing missing — the session token completes it

  let completion: string | undefined;
  for (const bucket of buckets) {
    const form = new FormData();
    for (const hash of bucket) {
      const file = byHash.get(hash);
      let content = file?.content;
      if (file && !content && recover) {
        // A re-serve missing bytes is the NORMAL first serve of new content (#578): the
        // push uploaded them to the version's archive script, and per-script dedupe means
        // this script has never seen them. Read them back, and verify the recovered bytes
        // hash to the manifest's content-address before uploading under it — the store is
        // shared, so a key must never be trusted on bytes that don't have it (D-44).
        const recovered = await recover({ path: file.path, hash: file.hash }).catch(() => undefined);
        if (recovered && (await assetHash(recovered, file.path)) !== file.hash) {
          throw new DeployUploadError(
            502,
            `recovered bytes for asset '${file.path}' do not hash to the manifest's ` +
              `'${file.hash}' — refusing to store them under a content-address they do not have`,
          );
        }
        content = recovered;
      }
      if (!file || !content) {
        // The runtime wants bytes neither this upload nor recovery could supply. A fresh
        // push mints a new archive script carrying every byte, which the next promote
        // recovers from — so the remedy it names is now a real one (#578).
        throw new DeployUploadError(
          502,
          `the runtime holds no bytes for asset '${file?.path ?? hash}' on '${scriptName}', this ` +
            `re-deploy carries none, and ${
              recover ? "the version's archive script gave none back" : 'no asset recovery is configured'
            } — push the version again to restore its static files`,
        );
      }
      // The part's Content-Type is what the file is SERVED as later, so it must be the
      // asset's own type, not the base64 envelope's.
      form.set(hash, new Blob([toBase64(content)], { type: file.contentType }), hash);
    }
    const res = await fetch(
      `https://api.cloudflare.com/client/v4/accounts/${opts.accountId}/workers/assets/upload?base64=true`,
      { method: 'POST', headers: { authorization: `Bearer ${sessionJwt}` }, body: form },
    );
    if (!res.ok) {
      const body = await res.text().catch(() => '');
      throw new DeployUploadError(
        res.status,
        `WfP asset upload failed (${res.status}) for '${scriptName}': ${clip(body)}`,
      );
    }
    const done = (await res.json().catch(() => ({}))) as { result?: { jwt?: string } };
    // Only the FINAL bucket's response carries the completion token; earlier ones answer
    // with an empty result. Keep the last one seen rather than assuming which it was.
    if (done.result?.jwt) completion = done.result.jwt;
  }
  if (!completion) {
    throw new DeployUploadError(
      502,
      `WfP asset upload for '${scriptName}' finished without a completion jwt`,
    );
  }
  return completion;
}

export function createWfpUploader(opts: WfpUploaderOptions): DeployVerticalFn {
  const injected = [
    ...Object.entries(opts.injectSecrets ?? {})
      .filter(([, text]) => text)
      .map(([name, text]) => ({ type: 'secret_text', name, text: text as string })),
    ...(opts.bindAi ? [{ type: 'ai', name: 'AI' }] : []),
  ];

  return async (deploymentRef, bundle, inPlace) => {
    // A fresh script declares every DO class under the first tag. An in-place update
    // of the serving script (#286) may only declare classes the script does not
    // already have — re-declaring a live class errors — so send the delta under a
    // bumped tag, or no migrations block at all when the class set is unchanged.
    const newClasses = inPlace
      ? bundle.doClasses.filter((cls) => !inPlace.priorDoClasses.includes(cls))
      : bundle.doClasses;
    const migrations = inPlace
      ? newClasses.length
        ? {
            old_tag: inPlace.priorMigrationTag,
            new_tag: nextMigrationTag(inPlace.priorMigrationTag),
            new_sqlite_classes: newClasses,
          }
        : undefined
      : // Every Substrat scope DO is SQLite-backed (new_sqlite_classes, not new_classes).
        { new_tag: 'v1', new_sqlite_classes: bundle.doClasses };

    // #340: static files go up FIRST, on their own path — the script PUT then names only
    // the completion token. A bundle with no assets runs no session at all, so nothing
    // about an assets-free vertical's upload changes.
    const assetsJwt =
      bundle.assets && bundle.assets.files.length > 0
        ? await uploadAssets(opts, deploymentRef, bundle.assets.files, bundle.assets.recoverContent)
        : undefined;

    const metadata = {
      main_module: bundle.entry,
      compatibility_date: bundle.compatibilityDate,
      // Without the declared flags (e.g. `nodejs_compat`) a script importing `node:*`
      // fails to start and the upload is rejected — carry them through.
      compatibility_flags: bundle.compatibilityFlags,
      // The vertical's own bindings, plus the platform's injected secrets (added here,
      // AFTER the §4 sandbox check on the declared set — the platform is granting the
      // vertical verification secrets, not the vertical reaching for a platform binding).
      bindings: [...bundle.bindings, ...injected],
      ...(migrations ? { migrations } : {}),
      // On the serving script, secrets put by hand or by an earlier deploy survive the
      // re-upload — this is what deletes the "re-put every secret on every new script"
      // ritual a per-version script forced.
      ...(inPlace ? { keep_bindings: ['secret_text', 'secret_key'] } : {}),
      // Builder logs exist to query (design/observability.md §4.4): without this the
      // pushed script's console output and exceptions are simply not recorded, and the
      // builder's only debugging tool is asking staff to redeploy with it on.
      //
      // `traces` is a SEPARATE switch (#858) — `enabled: true` alone yields logs only
      // while automatic tracing is in beta. Omitted unless the platform sets a sampling
      // rate, so a deploy of this code changes nothing about what prod emits.
      observability: {
        enabled: true,
        ...(opts.traceSampling !== undefined
          ? { traces: { enabled: true, head_sampling_rate: opts.traceSampling } }
          : {}),
      },
      // The static files uploaded above, plus how the runtime routes paths against them
      // (#340). Assets are versioned WITH the code: an upload carrying this block replaces
      // the script's asset set atomically, and one without it (a version that ships no
      // static files) leaves the script serving none — which is the honest outcome, since
      // keeping the outgoing version's assets beside incoming code is exactly the skew
      // native assets exist to prevent.
      ...(assetsJwt ? { assets: { jwt: assetsJwt, config: assetConfigOf(bundle.assets!) } } : {}),
    };

    const form = new FormData();
    form.set('metadata', new Blob([JSON.stringify(metadata)], { type: 'application/json' }), 'metadata.json');
    for (const m of bundle.modules) {
      form.set(m.name, new Blob([m.content as BlobPart], { type: m.contentType }), m.name);
    }

    const url =
      `https://api.cloudflare.com/client/v4/accounts/${opts.accountId}` +
      `/workers/dispatch/namespaces/${opts.namespace}/scripts/${encodeURIComponent(deploymentRef)}`;
    const res = await fetch(url, {
      method: 'PUT',
      headers: { authorization: `Bearer ${opts.apiToken}` },
      body: form,
    });
    if (!res.ok) {
      const body = await res.text().catch(() => '');
      // Carry the upstream CF status so the caller can answer a 4xx bad-bundle rejection
      // as a client error and a 5xx as a platform failure — not both as a blanket 502.
      // The body is clipped WITH a marker, never mid-token (#307); not a sandbox refusal.
      throw new DeployUploadError(
        res.status,
        `WfP upload failed (${res.status}) for '${deploymentRef}': ${clip(body)}`,
      );
    }
  };
}

/**
 * One D1 binding to guarantee on a dispatch script — the shape `PatchScriptBindingsFn`
 * ensures and the serving upload injects (per-tenant stores, #301).
 */
export interface D1BindingSpec {
  name: string;
  /** The D1 database id (the tenant-store ledger's `ref`). */
  id: string;
}

/**
 * One R2 binding to guarantee on a dispatch script (per-tenant blob stores, #473) — the
 * exact twin of {@link D1BindingSpec}, differing only in the Cloudflare binding shape a
 * bucket takes (`bucket_name`, not `id`).
 */
export interface R2BindingSpec {
  name: string;
  /** The R2 bucket name (the blob-store ledger's `ref`). */
  bucketName: string;
}

/** A binding the patcher guarantees on a serving script — a per-tenant store (#301) or
 *  blob store (#473). Discriminated so one PATCH carries both kinds. */
export type ScriptBindingSpec =
  | ({ type: 'd1' } & D1BindingSpec)
  | ({ type: 'r2_bucket' } & R2BindingSpec);

/**
 * Ensure a set of per-tenant bindings exists on a dispatch-namespace script WITHOUT
 * redeploying it (#301/#473): attach a freshly-minted store to the vertical's serving
 * script the moment it is provisioned, between full uploads. Resolves without touching
 * Cloudflare when every wanted binding is already present.
 */
export type PatchScriptBindingsFn = (
  scriptName: string,
  ensure: ScriptBindingSpec[],
) => Promise<void>;

/** A `ScriptBindingSpec` → the Cloudflare binding object the settings endpoint wants. */
function toCfBinding(b: ScriptBindingSpec): { type: string; name: string; [k: string]: unknown } {
  return b.type === 'd1'
    ? { type: 'd1', name: b.name, id: b.id }
    : { type: 'r2_bucket', name: b.name, bucket_name: b.bucketName };
}

/**
 * A `PatchScriptBindingsFn` over the namespace's script-settings endpoint: read the
 * current bindings, add the missing ones, PATCH the set back. Additive on purpose — it
 * never removes a binding (reap-time cleanup is the ledger's job, a separate step), and
 * secrets are never round-tripped: the GET cannot return their values, so they ride
 * `keep_bindings` exactly as an in-place upload's do (#286).
 */
export function createWfpBindingsPatcher(
  opts: Pick<WfpUploaderOptions, 'accountId' | 'namespace' | 'apiToken'>,
): PatchScriptBindingsFn {
  return async (scriptName, ensure) => {
    if (ensure.length === 0) return;
    const url =
      `https://api.cloudflare.com/client/v4/accounts/${opts.accountId}` +
      `/workers/dispatch/namespaces/${opts.namespace}/scripts/${encodeURIComponent(scriptName)}/settings`;
    const auth = { authorization: `Bearer ${opts.apiToken}` };

    const read = await fetch(url, { headers: auth });
    if (!read.ok) {
      const body = await read.text().catch(() => '');
      throw new Error(`WfP settings read failed (${read.status}) for '${scriptName}': ${clip(body)}`);
    }
    const settings = (await read.json().catch(() => ({}))) as {
      result?: { bindings?: { type: string; name: string; [k: string]: unknown }[] };
      bindings?: { type: string; name: string; [k: string]: unknown }[];
    };
    const current = settings.result?.bindings ?? settings.bindings ?? [];
    // Key "have" by (type, name): a store binding and an unrelated binding could in
    // principle share a name, and only a same-type match means "already attached".
    const have = new Set(current.map((b) => `${b.type}:${b.name}`));
    const missing = ensure.filter((b) => !have.has(`${b.type}:${b.name}`));
    if (missing.length === 0) return; // already attached — nothing to send

    // Secrets cannot be read back, so they must not be resent (a valueless entry would
    // wipe them) — they are inherited via keep_bindings; everything else is resent as-is.
    const carried = current.filter((b) => b.type !== 'secret_text' && b.type !== 'secret_key');
    const form = new FormData();
    form.set(
      'settings',
      new Blob(
        [
          JSON.stringify({
            bindings: [...carried, ...missing.map(toCfBinding)],
            keep_bindings: ['secret_text', 'secret_key'],
          }),
        ],
        { type: 'application/json' },
      ),
      'settings.json',
    );
    const res = await fetch(url, { method: 'PATCH', headers: auth, body: form });
    if (!res.ok) {
      const body = await res.text().catch(() => '');
      throw new Error(`WfP settings patch failed (${res.status}) for '${scriptName}': ${clip(body)}`);
    }
  };
}

/**
 * A `FetchVerticalModulesFn` over the namespace's script-content endpoint. The archive
 * script (one per pushed version) is the platform's bundle store — promote and backout
 * read the built modules back from it rather than requiring anyone to retain bytes.
 *
 * Cloudflare answers with `multipart/form-data` for a multi-module script and with the
 * bare module body (entrypoint named in `cf-entrypoint`) for a single-module one; both
 * shapes are handled with web-standard parsing only. In the multipart shape, a module
 * part need not carry `filename=` — the response is Cloudflare's format, not an echo of
 * the uploader's — so a part that parses as a string (not a File) is still a module.
 */
export function createWfpModulesFetcher(
  opts: Pick<WfpUploaderOptions, 'accountId' | 'namespace' | 'apiToken'>,
): FetchVerticalModulesFn {
  return async (deploymentRef) => {
    const url =
      `https://api.cloudflare.com/client/v4/accounts/${opts.accountId}` +
      `/workers/dispatch/namespaces/${opts.namespace}/scripts/${encodeURIComponent(deploymentRef)}/content`;
    const res = await fetch(url, { headers: { authorization: `Bearer ${opts.apiToken}` } });
    if (!res.ok) {
      const body = await res.text().catch(() => '');
      throw new Error(
        `WfP content read failed (${res.status}) for '${deploymentRef}': ${clip(body)}`,
      );
    }
    const contentType = res.headers.get('content-type') ?? '';
    if (contentType.includes('multipart/form-data')) {
      const form = await res.formData();
      const modules: VerticalBundle['modules'] = [];
      for (const [name, value] of form.entries()) {
        // A `metadata` part (if Cloudflare includes one) describes the script; it is not
        // a module and must not be re-uploaded as one.
        if (name === 'metadata') continue;
        if (value instanceof File) {
          modules.push({
            name,
            content: new Uint8Array(await value.arrayBuffer()),
            contentType: value.type || 'application/javascript+module',
          });
        } else {
          // A multipart part whose Content-Disposition carries no `filename=` is exposed
          // by the web-standard FormData parser (workerd and undici alike) as a STRING,
          // not a File. The GET /content response format is Cloudflare's choice, not an
          // echo of the filenames the uploader set, so a text module round-trips as a
          // string — carry it as a module rather than dropping it.
          modules.push({
            name,
            content: new TextEncoder().encode(value),
            contentType: 'application/javascript+module',
          });
        }
      }
      if (!modules.length) {
        // Say what actually arrived — the content-type and the received part names — so a
        // read-back that yields nothing is diagnosable from the one log line, not a source
        // trace.
        throw new Error(
          `WfP content for '${deploymentRef}' held no modules ` +
            `(content-type: ${contentType}; parts: ${[...form.keys()].join(', ') || 'none'})`,
        );
      }
      return modules;
    }
    const entry = res.headers.get('cf-entrypoint');
    if (!entry) {
      throw new Error(`WfP content for '${deploymentRef}' is single-module but names no cf-entrypoint`);
    }
    return [
      {
        name: entry,
        content: new Uint8Array(await res.arrayBuffer()),
        contentType: contentType || 'application/javascript+module',
      },
    ];
  };
}
