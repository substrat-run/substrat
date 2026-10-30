import { describe, expect, it } from 'vitest';
import { connectionId, permissionKey, scopeId, tenantId } from '@substrat-run/contracts';
import { ConnectorRevokeUnsupported, ulid } from '@substrat-run/kernel';
import { VerticalClient } from '@substrat-run/control-plane-api';
import { connectorRevokeThrough } from '../src/worker.js';

/**
 * #2732: a per-scope connection-grant revoke delivered to the deployment serving the scope, through
 * the vertical client it rides. A deployment built before `/internal/connector-revoke` answers
 * 404, which is "cannot revoke here yet", never a failure to be retried as one.
 */
describe('connectorRevokeThrough (#2732)', () => {
  const a = {
    connectionId: connectionId.parse(ulid()),
    tenantId: tenantId.parse(ulid()),
    scopeId: scopeId.parse(ulid()),
    vertical: 'acme-drive',
    permission: permissionKey.parse('drive:land-source'),
  };
  const clientAnswering = (status: number, body: unknown) =>
    new VerticalClient({
      fetch: (async () => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })) as unknown as typeof fetch,
      platformSecret: 'secret',
    });

  it("answers the deployment's revoked flag, and maps an older deployment's 404 to ConnectorRevokeUnsupported", async () => {
    await expect(connectorRevokeThrough(clientAnswering(200, { revoked: true, scopeId: a.scopeId }), a)).resolves.toBe(true);
    await expect(connectorRevokeThrough(clientAnswering(404, { error: 'not found' }), a)).rejects.toBeInstanceOf(ConnectorRevokeUnsupported);
  });
});
