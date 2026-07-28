import { nextMigrationTag } from './deploy.js';
import type { DeployVerticalFn, FetchVerticalModulesFn, VerticalBundle } from './deploy.js';

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
      // Surfaced as a 502-ish deploy failure by the caller; not a sandbox refusal.
      throw new Error(`WfP upload failed (${res.status}) for '${deploymentRef}': ${body.slice(0, 400)}`);
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
 * shapes are handled with web-standard parsing only.
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
        `WfP content read failed (${res.status}) for '${deploymentRef}': ${body.slice(0, 400)}`,
      );
    }
    const contentType = res.headers.get('content-type') ?? '';
    if (contentType.includes('multipart/form-data')) {
      const form = await res.formData();
      const modules: VerticalBundle['modules'] = [];
      for (const [name, value] of form.entries()) {
        if (value instanceof File) {
          modules.push({
            name,
            content: new Uint8Array(await value.arrayBuffer()),
            contentType: value.type || 'application/javascript+module',
          });
        }
      }
      if (!modules.length) throw new Error(`WfP content for '${deploymentRef}' held no modules`);
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
