import { DeployUploadError, nextMigrationTag } from './deploy.js';
import type { DeployVerticalFn, FetchVerticalModulesFn, VerticalBundle } from './deploy.js';

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
}

export function createWfpUploader(opts: WfpUploaderOptions): DeployVerticalFn {
  const injected = Object.entries(opts.injectSecrets ?? {})
    .filter(([, text]) => text)
    .map(([name, text]) => ({ type: 'secret_text', name, text: text as string }));

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
      observability: { enabled: true },
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
 * Ensure a set of D1 bindings exists on a dispatch-namespace script WITHOUT redeploying
 * it (#301): attach a freshly-minted tenant store to the vertical's serving script the
 * moment it is provisioned, between full uploads. Resolves without touching Cloudflare
 * when every wanted binding is already present.
 */
export type PatchScriptBindingsFn = (scriptName: string, ensure: D1BindingSpec[]) => Promise<void>;

/**
 * A `PatchScriptBindingsFn` over the namespace's script-settings endpoint: read the
 * current bindings, add the missing D1 bindings, PATCH the set back. Additive on
 * purpose — it never removes a binding (reap-time cleanup is the ledger's job, a
 * separate step), and secrets are never round-tripped: the GET cannot return their
 * values, so they ride `keep_bindings` exactly as an in-place upload's do (#286).
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
    const have = new Set(current.filter((b) => b.type === 'd1').map((b) => b.name));
    const missing = ensure.filter((b) => !have.has(b.name));
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
            bindings: [...carried, ...missing.map((b) => ({ type: 'd1', name: b.name, id: b.id }))],
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
