import {
  builderTurnDetail,
  builderTurnsPage,
  type BuilderTurnDetail,
  type BuilderTurnsPage,
} from '@substrat-run/contracts';
import { ControlPlaneError } from '@substrat-run/control-plane-client';

/**
 * The builder studio's turn summaries, read across every team (the builder's
 * `GET /internal/turns`). Staff-only: a summary names the team and the project,
 * and the turn behind it carries what a builder typed.
 */
export interface BuilderTurnsService {
  list(query: URLSearchParams): Promise<BuilderTurnsPage>;
  /** Null when the builder holds no turn with that id. */
  get(turnId: string): Promise<BuilderTurnDetail | null>;
}

/** The service over the builder's binding, behind the platform service token. */
export function builderTurnsService(
  service: { fetch(request: Request): Promise<Response> } | undefined,
  token: string | undefined,
): BuilderTurnsService {
  const read = async (path: string): Promise<Response> => {
    if (!service || !token) throw new ControlPlaneError(503, 'the builder studio is not configured');
    let response: Response;
    try {
      response = await service.fetch(new Request(`https://builder/internal/${path}`, { headers: { 'x-service-token': token } }));
    } catch (e) {
      console.error('builder-turns.connection-failed', { detail: e instanceof Error ? e.message : String(e) });
      throw new ControlPlaneError(502, 'the builder studio connection failed before it answered');
    }
    return response;
  };
  // Parse, don't trust: what the builder answers is held to the shape the console renders.
  const body = async <T>(response: Response, schema: { parse(value: unknown): T }): Promise<T> => {
    if (!response.ok) {
      const problem = (await response.json().catch(() => null)) as { detail?: string } | null;
      throw new ControlPlaneError(response.status >= 500 ? 502 : response.status, problem?.detail ?? 'the builder studio refused the read');
    }
    try {
      return schema.parse(await response.json());
    } catch {
      throw new ControlPlaneError(502, 'the builder studio answered a turn read in a shape this control plane does not know');
    }
  };
  return {
    async list(query) {
      return body(await read(`turns${query.size ? `?${query}` : ''}`), builderTurnsPage);
    },
    async get(turnId) {
      const response = await read(`turns/${encodeURIComponent(turnId)}`);
      if (response.status === 404) return null;
      return body(response, builderTurnDetail);
    },
  };
}
