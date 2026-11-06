import { sourceBuildRecord, sourceBuildResult, type BuiltSource, type SourceBuildService } from '@substrat-run/contracts';
import { ControlPlaneError } from '@substrat-run/control-plane-client';

/**
 * A build that stopped before the builder could answer for it (#2931). The message is the
 * reviewed sentence the caller reads; `diagnostic` is the runtime's own text, unreviewed, so it
 * goes on the row only staff read.
 */
export class SourceBuildInterrupted extends ControlPlaneError {
  constructor(status: number, message: string, readonly diagnostic: string) {
    super(status, message);
  }
}

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
      // sentence; the underlying message is logged and kept for staff, never answered.
      const detail = e instanceof Error ? e.message : String(e);
      console.error('source-build.connection-failed', { tenantId, detail });
      throw new SourceBuildInterrupted(502, 'the build service connection failed before it answered', detail);
    }
    if (!response.ok) {
      const problem = await response.json().catch(() => null) as { detail?: string; diagnostic?: unknown } | null;
      const detail = problem?.detail ?? 'platform build service failed';
      if (typeof problem?.diagnostic === 'string') throw new SourceBuildInterrupted(response.status, detail, problem.diagnostic);
      throw new ControlPlaneError(response.status, detail);
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
    async record(tenantId, buildId) {
      const response = await request(tenantId, `builds/${encodeURIComponent(buildId)}`);
      if (response.status === 404) return null;
      if (!response.ok) {
        const problem = await response.json().catch(() => null) as { detail?: string } | null;
        throw new ControlPlaneError(response.status >= 500 ? 502 : response.status, problem?.detail ?? 'the build service refused the read');
      }
      const record = sourceBuildRecord.safeParse(await response.json().catch(() => null));
      if (!record.success) throw new ControlPlaneError(502, 'the build service answered a record in a shape this control plane does not know');
      return record.data;
    },
    async projects(tenantId, input) {
      return request(tenantId, 'projects', {
        method: input.method,
        ...(input.method === 'GET' ? {} : { headers: { 'content-type': 'application/json' }, body: await input.text() }),
      });
    },
  };
}
