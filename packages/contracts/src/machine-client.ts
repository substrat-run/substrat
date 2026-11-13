import { z } from 'zod';
import { scopeId, tenantId } from './ids.js';

/**
 * An app's MACHINE client at the team auth-server it signs in with (#3134).
 *
 * A team auth-server serves machine-facing APIs of its own — SCIM at `/scim/v2` (#2941) and
 * the Management API subset at `/api/v2` (#3107) — to a client that authenticates as itself
 * with `client_credentials` (#2267). An app's sign-in client is registered for it when the
 * app is installed; its machine client was four steps by hand. An app now DECLARES the
 * issuer scopes it needs (package.json `substrat.issuerScopes`, {@link issuerScopes}) and
 * the platform registers one machine client per app at the app's own issuer, holding the
 * declared scopes the issuer's operator allows.
 *
 * This module is the vocabulary between the two ends: the control plane, which decides when,
 * and the team auth-server (`demos/auth-server`), which registers, converges and removes.
 * Two platform-gated routes on the issuer, each addressed by the issuer's OWN scope and
 * refused unless that scope is the named tenant's instance:
 *
 *   - `POST   /internal/machine-client` — ensure the app's client: register it, or converge
 *     the one it has on the name and the scopes.
 *   - `DELETE /internal/machine-client` — remove the app's client, and only that one.
 *
 * ## One client per app, found by the app's scope
 *
 * SCIM lets only the client that created an account change it, so two apps sharing a
 * client would share each other's accounts. The issuer records each client it registered
 * here in its own `app_machine_client` table, keyed by the app's scope. Every verb finds
 * its client there and nowhere else, so no verb can reach a client an operator registered
 * in the console, nor one somebody registered dynamically.
 *
 * ## The ceiling stays the operator's
 *
 * The issuer's `MACHINE_SCOPES` setting bounds every machine client, this one included.
 * An ensure grants the declared scopes that are inside it and answers the rest as
 * `withheld`, by name, so the caller can say which scope is missing and where to add it.
 * Nothing is dropped silently, and nothing is granted beyond the ceiling. When the ceiling
 * widens, the next ensure grants what was withheld without issuing a new secret.
 *
 * ## The secret is answered once
 *
 * The issuer stores the secret hashed. An ensure answers it when it registered the client
 * and when the call asked to `rotate`; never otherwise. A rotation keeps the client id,
 * because the accounts a client provisioned through SCIM belong to that id.
 */

/** The issuer-side path of both verbs. */
export const MACHINE_CLIENT_PATH = '/internal/machine-client';

/**
 * The scopes a person grants by signing in. A machine client holds none of them: it has no
 * person to speak for, and the issuer's ceiling refuses them too.
 */
export const SIGN_IN_SCOPES: readonly string[] = ['openid', 'profile', 'email', 'offline_access'];

/** RFC 6749 §3.3 `scope-token`: printable ASCII without space, `"` or `\`. */
const SCOPE_TOKEN = /^[\x21\x23-\x5B\x5D-\x7E]+$/;

/**
 * One scope of the issuer's machine APIs, such as `read:users` or `users:provision`. A comma
 * is refused because the issuer's `MACHINE_SCOPES` setting is a comma-separated list, so a
 * scope holding one could never be put in the ceiling.
 */
export const issuerScope = z
  .string()
  .min(1)
  .max(128)
  .regex(SCOPE_TOKEN, 'a scope token: printable ASCII without space, quote or backslash')
  .refine((s) => !s.includes(','), 'a scope cannot contain a comma')
  .refine((s) => !SIGN_IN_SCOPES.includes(s), 'a scope a person grants by signing in cannot be held by a machine client');

/**
 * An app's declared issuer scopes — package.json `substrat.issuerScopes`. A request, bounded
 * by the issuer's `MACHINE_SCOPES` ceiling: declaring a scope grants nothing by itself.
 */
export const issuerScopes = z
  .array(issuerScope)
  .max(32)
  .refine((list) => new Set(list).size === list.length, 'each scope is named once');
export type IssuerScopes = z.infer<typeof issuerScopes>;

/** The issuer the call addresses: its own scope, and the tenant that scope must belong to. */
const issuerAddress = {
  tenantId,
  scopeId,
};

/**
 * `POST /internal/machine-client` — ensure the app's machine client. With no client recorded
 * for `appScopeId` the issuer registers one and answers its secret. With one recorded it
 * converges the name and the scopes and answers no secret, unless `rotate` asks for a new one.
 */
export const machineClientEnsure = z.object({
  ...issuerAddress,
  appScopeId: scopeId,
  clientName: z.string().trim().min(1).max(200),
  scopes: issuerScopes,
  rotate: z.boolean().optional(),
});
export type MachineClientEnsure = z.infer<typeof machineClientEnsure>;

/**
 * What an ensure answers. `clientSecret` is present ONLY when this call registered the client
 * or rotated its secret; the issuer stores it hashed and cannot answer it again. `scopes` are
 * the ones the client holds now; `withheld` are the declared ones outside the issuer's ceiling.
 */
export const ensuredMachineClient = z.object({
  clientId: z.string().min(1),
  clientSecret: z.string().min(1).optional(),
  scopes: z.array(z.string()),
  withheld: z.array(z.string()),
});
export type EnsuredMachineClient = z.infer<typeof ensuredMachineClient>;

/** `DELETE /internal/machine-client` — remove the app's machine client and its tokens. */
export const machineClientRemove = z.object({
  ...issuerAddress,
  appScopeId: scopeId,
});
export type MachineClientRemove = z.infer<typeof machineClientRemove>;

/** What a remove did: the client it deleted, or null when the app had none recorded. */
export const removedMachineClient = z.object({ removed: z.string().nullable() });
export type RemovedMachineClient = z.infer<typeof removedMachineClient>;

/**
 * The declared issuer scopes of a STORED manifest — `callsOfManifestJson`'s sibling. Empty
 * when the manifest declares none, cannot be read, or was pushed before the declaration
 * existed: all three mean the app asks for no machine client. A stored entry that is not a
 * valid scope is left out rather than trusted.
 */
export function issuerScopesOfManifestJson(manifestJson: string | null | undefined): string[] {
  if (!manifestJson) return [];
  try {
    const m = JSON.parse(manifestJson) as { issuerScopes?: unknown };
    if (!Array.isArray(m.issuerScopes)) return [];
    return [...new Set(m.issuerScopes.filter((v): v is string => issuerScope.safeParse(v).success))];
  } catch {
    return [];
  }
}
