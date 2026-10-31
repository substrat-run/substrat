import { sourceBuildResult, type BuiltSource, type SourceBuildService } from '@substrat-run/contracts';
import { ControlPlaneError } from '@substrat-run/control-plane-client';

/** Private service transport. An absent binding fails closed; it never accepts local bundles. */
export function sourceBuildService(service: { fetch(request: Request): Promise<Response> } | undefined, token: string | undefined): SourceBuildService {
  const request = async (tenantId: string, path: string, init?: RequestInit): Promise<Response> => {
    if (!service || !token) throw new ControlPlaneError(503, 'platform source builds are not configured');
    return service.fetch(new Request(`https://builder/internal/${path}`, {
      ...init,
      headers: { ...Object.fromEntries(new Headers(init?.headers)), 'x-service-token': token, 'x-substrat-tenant': tenantId },
    }));
  };
  const release = async (tenantId: string, sent: Promise<Response>, revision: string | undefined): Promise<BuiltSource> => {
    let response: Response;
    try {
      response = await sent;
    } catch (e) {
      if (e instanceof ControlPlaneError) throw e;
      // The service binding rejects when the builder's isolate dies mid-build. The caller reads the
      // sentence; the underlying message stays in the log, as `deploy.upload.failed` keeps its own.
      console.error('source-build.connection-failed', { tenantId, detail: e instanceof Error ? e.message : String(e) });
      throw new ControlPlaneError(502, 'the build service connection failed before it answered');
    }
    if (!response.ok) {
      const problem = await response.json().catch(() => null) as { detail?: string } | null;
      throw new ControlPlaneError(response.status, problem?.detail ?? 'platform build service failed');
    }
    let form: FormData;
    try { form = await response.formData(); } catch { throw new ControlPlaneError(502, 'build service returned an invalid multipart release'); }
    const result = form.get('buildResult');
    if (typeof result !== 'string') throw new ControlPlaneError(502, 'build service returned no release identity');
    let decoded: unknown;
    try { decoded = JSON.parse(result); } catch { throw new ControlPlaneError(502, 'build service returned an invalid release identity'); }
    const metadata = sourceBuildResult.safeParse(decoded);
    if (!metadata.success) throw new ControlPlaneError(502, 'build service returned an invalid release identity');
    if (revision && metadata.data.revision !== revision) throw new ControlPlaneError(502, 'build service did not build the requested source revision');
    form.delete('buildResult');
    return { form, ...metadata.data };
  };
  return {
    // Not async: an async frame keeps its locals alive across every await, so `input` and its
    // serialisation would be held for the whole build. Here the request, snapshot and all, is
    // serialised once into the outgoing body, and only the response and the revision wait.
    build(tenantId, slug, input): Promise<BuiltSource> {
      const sent = request(tenantId, 'build', {
        method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ slug, request: input }),
      });
      return release(tenantId, sent, input.revision);
    },
    async projects(tenantId, input) {
      return request(tenantId, 'projects', {
        method: input.method,
        ...(input.method === 'GET' ? {} : { headers: { 'content-type': 'application/json' }, body: await input.text() }),
      });
    },
  };
}
