import { MCP_AUTHORIZATION_SERVERS_PATH } from '@substrat-run/contracts';
import { issuerRefusal } from '@substrat-run/oidc-rp/discovery';

/** Public configuration only: no session, upstream fetch, registration, or credentials. */
export function mcpDiscovery(request: Request, issuer: string): Response | undefined {
  if (new URL(request.url).pathname !== MCP_AUTHORIZATION_SERVERS_PATH) return undefined;
  if (request.method !== 'GET') return new Response(null, { status: 405, headers: { Allow: 'GET' } });
  return Response.json(
    { authorization_servers: issuerRefusal(issuer) === null ? [issuer] : [] },
    { headers: { 'Cache-Control': 'no-store' } },
  );
}
