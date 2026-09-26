import { z } from 'zod';
import { scopeId } from './ids.js';

/**
 * DELEGATION between two apps that sign in at one team auth-server (#1824).
 *
 * A host app's users are signed in at the issuer. Another app of the same team, the ACTOR
 * (a help desk's assistant, say), wants to call the host's MCP endpoint on behalf of one of
 * those users. The issuer answers that with RFC 8693 token exchange, in two steps: the host
 * asks for an assertion addressed to the actor, and the actor trades it for an access token
 * for the host's MCP endpoint. Neither step is allowed unless the platform said the host
 * delegates to that actor, and for which of the host's permissions.
 *
 * This module is that statement's vocabulary. The dashboard delivers it, per host app, through
 * the issuer's platform-gated `/internal/configure`:
 *
 *     substrat:delegations:<host app scope id>  =  [{ "actor": "<actor app scope id>",
 *                                                    "permissions": ["tickets.read", …] }, …]
 *
 * The value is the host's WHOLE set, not a delta, so re-sending it is a no-op, an actor that
 * drops out loses its grant, and `""` or `[]` revokes every one. The issuer re-reads the grant
 * on every exchange, so a revocation takes effect within one token lifetime.
 * `demos/auth-server/src/delegations.ts` turns it into rows.
 */
export const DELEGATIONS_CONFIG_PREFIX = 'substrat:delegations:';

/** RFC 8693 §2.1: the `grant_type` of a token-exchange request. */
export const TOKEN_EXCHANGE_GRANT_TYPE = 'urn:ietf:params:oauth:grant-type:token-exchange';

/** RFC 8693 §3: the token types an exchange names, as `subject_token_type` or `issued_token_type`. */
export const TOKEN_TYPE = {
  accessToken: 'urn:ietf:params:oauth:token-type:access_token',
  idToken: 'urn:ietf:params:oauth:token-type:id_token',
  jwt: 'urn:ietf:params:oauth:token-type:jwt',
} as const;

/**
 * The second `aud` of a delegation ASSERTION (the first exchange's product), beside the actor's
 * client id. It makes the audience multi-valued, which is one of the reasons no vertical's
 * bearer check takes an assertion as a user's token, and it is what the second exchange
 * requires to find. A URN rather than a URL, so it can never be anybody's resource.
 */
export const DELEGATION_ASSERTION_AUDIENCE = 'urn:substrat:delegation-assertion';

/** More permissions than one host defines; a bound on what one grant carries. */
export const MAX_DELEGATED_PERMISSIONS = 64;

/** More actors than any host delegates to; a bound on what one delivery writes. */
export const MAX_DELEGATION_ACTORS = 64;

/**
 * One permission key, as it travels in an OAuth `scope`. RFC 6749 §3.3 separates scope tokens
 * by spaces and allows only printable ASCII other than `"` and `\` in one, so a key outside
 * that set could never be asked for, or would split into two when it was.
 */
const delegatedPermission = z
  .string()
  .min(1)
  .max(128)
  .regex(/^[\x21\x23-\x5b\x5d-\x7e]+$/, 'an OAuth scope token (RFC 6749 §3.3)');

/** One actor the host delegates to, and which of the host's permissions it may act with. */
export const delegationGrant = z
  .object({
    actor: scopeId,
    permissions: z.array(delegatedPermission).min(1).max(MAX_DELEGATED_PERMISSIONS),
  })
  .strict();

export type DelegationGrant = z.infer<typeof delegationGrant>;

/**
 * A host's whole set. An actor named twice is refused: which of the two grants would win is
 * not a question this should answer by accident.
 */
export const delegationGrants = z
  .array(delegationGrant)
  .max(MAX_DELEGATION_ACTORS)
  .refine((grants) => new Set(grants.map((g) => g.actor)).size === grants.length, 'an actor is named twice');
