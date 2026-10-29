import { createControlPlaneApi as createApi, type ControlPlaneApiOptions } from '../../src/index.js';

/**
 * Existing release-validation suites describe compiler outputs as multipart fixtures.
 * Feed those through the private build seam while issuing source requests to the public
 * route. This keeps sandbox, admission, store and uploader assertions on the same path
 * without keeping a public prebuilt-module endpoint for the sake of test fixtures.
 */
export function createControlPlaneApi(options: ControlPlaneApiOptions): ReturnType<typeof createApi> {
  if (options.sourceBuilds) return createApi(options);
  const releases = new Map<string, FormData>();
  let sequence = 0;
  const app = createApi({
    ...options,
    sourceBuilds: {
      async build(_tenant, _slug, input) {
        const form = releases.get(input.revision!);
        if (!form) throw new Error('missing build fixture');
        releases.delete(input.revision!);
        return { form, projectId: 'fixture-project', revision: input.revision!, dataLoss: { status: 'passed', authored: 0 } };
      },
      async projects() { throw new Error('project catalog is not part of a release fixture'); },
    },
  });
  const fetch = app.fetch.bind(app);
  app.fetch = async (request, ...args) => {
    if (request.method === 'POST' && new URL(request.url).pathname.endsWith('/deploy') && request.headers.get('content-type')?.startsWith('multipart/form-data')) {
      const form = await request.formData();
      const revision = (++sequence).toString(16).padStart(40, '0');
      releases.set(revision, form);
      let version = '0.1.0';
      try { version = JSON.parse(String(form.get('manifest')))?.version ?? version; } catch { /* malformed build output is the scenario */ }
      const headers = new Headers(request.headers);
      headers.set('content-type', 'application/json');
      headers.delete('content-length');
      request = new Request(request.url, {
        method: request.method, headers,
        body: JSON.stringify({ version, revision, ...(typeof form.get('tenant') === 'string' ? { tenant: form.get('tenant') } : {}), allowFork: form.get('allowFork') === '1' }),
      });
    }
    return fetch(request, ...args);
  };
  return app;
}
