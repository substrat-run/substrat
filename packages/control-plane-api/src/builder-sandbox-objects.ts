import { builderSandboxObjects, type BuilderSandboxObjects } from '@substrat-run/contracts';
import { ControlPlaneError } from '@substrat-run/control-plane-client';

/**
 * The Sandbox Durable Objects one team's builder containers run as (#3316), read from the builder's
 * `GET /internal/sandbox-objects`. A container instance is its Sandbox object, so this is how the
 * cost rollup's container backfill charges usage Cloudflare recorded before sandboxes carried a
 * tenant label. Staff-only: it names project slugs.
 */
export type BuilderSandboxObjectsService = (tenantId: string) => Promise<BuilderSandboxObjects['objects']>;

/** The service over the builder's binding, behind the platform service token. */
export function builderSandboxObjectsService(
  service: { fetch(request: Request): Promise<Response> } | undefined,
  token: string | undefined,
): BuilderSandboxObjectsService {
  return async (tenantId) => {
    if (!service || !token) throw new ControlPlaneError(503, 'the builder studio is not configured');
    let response: Response;
    try {
      response = await service.fetch(
        new Request('https://builder/internal/sandbox-objects', { headers: { 'x-service-token': token, 'x-substrat-tenant': tenantId } }),
      );
    } catch (e) {
      console.error('builder-sandbox-objects.connection-failed', { detail: e instanceof Error ? e.message : String(e) });
      throw new ControlPlaneError(502, 'the builder studio connection failed before it answered');
    }
    if (!response.ok) throw new ControlPlaneError(502, `the builder studio refused the sandbox-object read (HTTP ${response.status})`);
    // Parse, don't trust: an id that is not Cloudflare's shape would match nothing, silently.
    const parsed = builderSandboxObjects.safeParse(await response.json().catch(() => null));
    if (!parsed.success) throw new ControlPlaneError(502, 'the builder studio answered a sandbox-object read in a shape this control plane does not know');
    return parsed.data.objects;
  };
}
