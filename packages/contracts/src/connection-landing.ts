import { z } from 'zod';
import { permissionKey } from './ids.js';
import { connectionProvider } from './connections.js';

/**
 * Connection landings (#2316): how a poll-only connector's data enters a vertical's scope, declared
 * by the vertical that receives it.
 *
 * A poll-only connector (Fortnox, Planima) has nothing inside a scope to start its work, so it
 * needs a BINDING: "sweep this connection into that scope, through this operation, holding this
 * key". Before this declaration a binding came only from a person running `substrat connection
 * bind`, and the key it needs from a vertical's own credential relay. A connection a company
 * approved through a connect link or the dashboard's door held no key and had no binding, so
 * nothing landed and nothing said so.
 *
 * The shape of the mechanism, so the pieces below read in place:
 *
 * - **The vertical declares the landing** — `connections` in its module manifest
 *   (`connectionLandingSpec`): the provider, the operation the connector invokes, and the key that
 *   operation checks. It is lifted into the permission registry, so it is rendered in the
 *   vertical's PERMISSIONS.md and hashed into its permission digest: the key a connection is
 *   given is a reviewed permission diff, and a version that widens it cannot be promoted
 *   unacknowledged.
 * - **The platform seats and binds from the running version.** On each connector pass, every
 *   live connection of a declared provider in a tenant where the vertical is installed is granted
 *   the declared key on each primary, active install, and bound to it. Both steps happen only when
 *   missing or different, so a pass that finds them in place writes nothing. The bind is the
 *   connector's own, and it still refuses a connection that does not hold the key.
 * - **Revocation is the connection's.** Revoking a connection tombstones its grants and deletes
 *   its bindings, and a revoked connection is never seated again.
 */

/** The most option keys one landing may carry. */
export const CONNECTION_LANDING_OPTIONS_MAX = 16;

/**
 * Provider-specific binding options (Planima's `organizationId`, `currency`, `window`,
 * `horizonYears`), as JSON. Not typed per provider here: the contracts package names no connector,
 * and the platform validates them with the provider's own schema before it binds. A declaration a
 * provider refuses is reported on that connection's sweep row, never bound with a guess.
 */
export const connectionLandingOptions = z
  .record(z.string().min(1), z.unknown())
  .refine((o) => Object.keys(o).length <= CONNECTION_LANDING_OPTIONS_MAX, {
    message: `a landing carries at most ${CONNECTION_LANDING_OPTIONS_MAX} options`,
  });
export type ConnectionLandingOptions = z.infer<typeof connectionLandingOptions>;

/**
 * One declared landing — "a `provider` connection of this tenant lands through `operation`,
 * holding `permission`" — as a module manifest's `connections` entry.
 *
 * `operation` is the full `module/operation` name the connector invokes. It is not checked against
 * the module's own operations here: a vertical may land through an operation of an engine it
 * composes, and the host's registry is what knows every name. `lint:permissions` reports an
 * unknown one, and an unknown name lands nothing (the sweep reports the refusal).
 *
 * `permission` is what the connection is granted, and it must be a key some module declares and
 * that is not reserved to a system principal: a connection acts for the external provider holding
 * its token. The registry builder refuses both.
 */
export const connectionLandingSpec = z
  .object({
    provider: connectionProvider,
    operation: z.string().regex(/^[a-zA-Z0-9_-]+\/[a-zA-Z0-9_-]+$/, 'operation is `module/operation`'),
    permission: permissionKey,
    options: connectionLandingOptions.optional(),
  })
  .strict();
export type ConnectionLandingSpec = z.infer<typeof connectionLandingSpec>;
