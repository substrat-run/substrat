import { z } from 'zod';
import { scopeId } from './ids.js';

/**
 * DELEGATION between two apps that sign in at one team auth-server (#1824, #3161).
 *
 * A host app's users are signed in at the issuer. Another app of the same team, the ACTOR, wants
 * to call the host on behalf of one of those people. The issuer answers that with RFC 8693 token
 * exchange, on one of two CHANNELS, and neither is allowed unless the platform said the host
 * delegates to that actor, on that channel, and for which of the host's permissions.
 *
 * - **`mcp`** (#1824): two steps. The HOST asks for an assertion addressed to the actor, and the
 *   actor trades it for an access token for the host's MCP endpoint. A help desk's assistant
 *   acting in another app is the shape: the host takes a step for every person it lets the actor
 *   act for.
 * - **`peer`** (#3161): one step. The ACTOR presents the live token of a person signed in to the
 *   actor, names the host's OIDC client id as `audience`, and asks for an access token
 *   (`requested_token_type` = {@link TOKEN_TYPE}.accessToken, which is what tells this exchange
 *   from the second step of `mcp`). The token it gets has `sub` = the person, `aud` = the host's
 *   client id, `act.sub` = the actor's client id, and `scope` = the granted keys, and the actor
 *   presents it on a peer call (`peerCallRequest.onBehalf`). A master app calling its plugin as
 *   the signed-in person is the shape.
 *
 * A grant names its channels, and one that names none means `mcp` alone ({@link channelsOf}), so
 * every grant delivered before `peer` existed keeps exactly the meaning it had. `peer` has to be
 * asked for by name because it is the wider of the two: with it, the actor can act for ANYONE
 * signed in to the actor, and the host takes no step per person. An `mcp` grant never allowed
 * that, so no grant may come to mean it by a default.
 *
 * This module is that statement's vocabulary. The dashboard delivers it, per host app, through
 * the issuer's platform-gated `/internal/configure`:
 *
 *     substrat:delegations:<host app scope id>  =  [{ "actor": "<actor app scope id>",
 *                                                    "permissions": ["tickets.read", …],
 *                                                    "channels": ["peer"] }, …]
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

/** The exchanges a grant may admit. See the module header for what each one is. */
export const DELEGATION_CHANNELS = ['mcp', 'peer'] as const;
export const delegationChannel = z.enum(DELEGATION_CHANNELS);
export type DelegationChannel = z.infer<typeof delegationChannel>;

/** What a grant that names no channel admits: the one channel there was before #3161. */
const DEFAULT_CHANNELS: readonly DelegationChannel[] = ['mcp'];

/**
 * Channels as a grant or a manifest names them: at least one, each once. A channel named twice
 * is refused rather than collapsed, so a delivery reads back exactly as it was written.
 */
export const delegationChannels = z
  .array(delegationChannel)
  .min(1)
  .refine((cs) => new Set(cs).size === cs.length, 'a channel is named twice');

/**
 * One actor the host delegates to, which of the host's permissions it may act with, and on which
 * channels. `channels` absent is `['mcp']`; read it through {@link channelsOf}, never directly.
 */
export const delegationGrant = z
  .object({
    actor: scopeId,
    permissions: z.array(delegatedPermission).min(1).max(MAX_DELEGATED_PERMISSIONS),
    channels: delegationChannels.optional(),
  })
  .strict();

export type DelegationGrant = z.infer<typeof delegationGrant>;

/** The channels a grant admits, with the default applied: absent is `mcp` alone, never `peer`. */
export const channelsOf = (grant: Pick<DelegationGrant, 'channels'>): DelegationChannel[] => [
  ...(grant.channels ?? DEFAULT_CHANNELS),
];

/**
 * A host's whole set. An actor named twice is refused: which of the two grants would win is
 * not a question this should answer by accident.
 */
export const delegationGrants = z
  .array(delegationGrant)
  .max(MAX_DELEGATION_ACTORS)
  .refine((grants) => new Set(grants.map((g) => g.actor)).size === grants.length, 'an actor is named twice');
