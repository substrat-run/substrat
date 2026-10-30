/**
 * The deployment serving a scope cannot take a connection-grant revoke (#2732): it runs a
 * vertical-host that predates `/internal/connector-revoke`. Thrown by `revokeFromConnection`
 * before the directory record moves, so nothing is half-revoked; the grant stays as it was until
 * that vertical upgrades and the revoke is asked again.
 */
export class ConnectorRevokeUnsupported extends Error {
  constructor(readonly vertical: string) {
    super(
      `the deployment serving this scope (vertical '${vertical}') cannot revoke a connection's grant: ` +
        'its @substrat-run/vertical-host predates the revoke delivery. Nothing was changed; upgrade the vertical and ask again.',
    );
    this.name = 'ConnectorRevokeUnsupported';
  }
}
