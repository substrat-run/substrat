import { z } from 'zod';
import { scopeId, tenantId } from './ids.js';

/**
 * A MANAGED tenant's sign-in client at its manager's team auth-server (#3202, D-72, #3261).
 *
 * A `provision-tenant` request may name one of the manager's own team auth-servers as the new
 * tenant's issuer. The platform then registers the tenant a sign-in client there, delivers it
 * to the tenant's scope as `substrat:auth`, and registers the scope as a place under the
 * tenant's own key. Registering by open dynamic registration made a retry register a second
 * client and orphan the first, and left nothing that could remove the client when the tenant
 * ended. So the platform registers it through this protocol instead: two platform-gated
 * routes on the issuer, each addressed by the issuer's OWN scope and refused unless that scope
 * is the named tenant's instance, as for the machine client (#3134):
 *
 *   - `POST   /internal/managed-client` — ensure the managed app's client: register it, or give
 *     the one recorded for it a new secret.
 *   - `DELETE /internal/managed-client` — remove the managed app's client, and its place and
 *     redirect record at this issuer.
 *
 * ## One client per managed app, found by the app's scope
 *
 * The issuer records each client it registered here in its own `managed_client` table, keyed by
 * the managed app's scope. The platform's retry repeats that scope id (it is the request's own),
 * so a retry finds the client the first pass registered rather than registering another. Every
 * verb finds its client there and nowhere else, so no verb can reach a client an operator
 * registered in the console, somebody registered dynamically, or the dashboard registered for an
 * app it installed.
 *
 * ## Every ensure answers a secret
 *
 * The issuer stores secrets hashed, and the platform keeps no copy of delivered config, so a
 * retry cannot learn the secret the first pass delivered. An ensure therefore always answers
 * one: the new client's, or a new one for the recorded client, which keeps its id. Its caller
 * delivers it to the managed scope straight away. Tokens already issued are left alone.
 *
 * ## URIs come from the hostname
 *
 * An ensure names the managed app's hostname, never a URI. The issuer derives the callback and
 * the post-logout targets from it (`clientRedirectUris`), as it does for a redirects delivery, so
 * no call can register an arbitrary redirect.
 */

/** The issuer-side path of both verbs. */
export const MANAGED_CLIENT_PATH = '/internal/managed-client';

/** The issuer the call addresses: its own scope, and the tenant (the manager's) it must belong to. */
const issuerAddress = {
  tenantId,
  scopeId,
};

/** The managed app the client is for: the provisioned tenant, and its scope. */
const managedApp = {
  appTenantId: tenantId,
  appScopeId: scopeId,
};

/** A bare hostname: lowercase labels, no scheme, no port. */
const managedHostname = z
  .string()
  .max(253)
  .regex(/^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]*[a-z0-9])?)+$/, 'a bare hostname');

/**
 * `POST /internal/managed-client` — ensure the managed app's sign-in client. With none recorded
 * for `appScopeId` the issuer registers one for `hostname`; with one recorded it gives it a new
 * secret, sets its name, and adds `hostname`'s URIs if they are missing. Either way it answers
 * the secret.
 */
export const managedClientEnsure = z
  .object({
    ...issuerAddress,
    ...managedApp,
    hostname: managedHostname,
    clientName: z.string().trim().min(1).max(200),
  })
  .strict();
export type ManagedClientEnsure = z.infer<typeof managedClientEnsure>;

/** What an ensure answers. The issuer stores the secret hashed, and cannot answer it again. */
export const ensuredManagedClient = z.object({
  clientId: z.string().min(1),
  clientSecret: z.string().min(1),
  /** True when this call registered the client, false when it gave the recorded one a new secret. */
  registered: z.boolean(),
});
export type EnsuredManagedClient = z.infer<typeof ensuredManagedClient>;

/**
 * `DELETE /internal/managed-client` — remove the managed app's client and what it holds, its
 * place (the `place_app` row under `appTenantId`, and the members reported under it) and the
 * platform's redirect record for `appScopeId`. The place and the record go even when no client
 * is recorded, so an app registered before this protocol is unlisted too. Repeating it is a no-op.
 */
export const managedClientRemove = z
  .object({
    ...issuerAddress,
    ...managedApp,
  })
  .strict();
export type ManagedClientRemove = z.infer<typeof managedClientRemove>;

/** What a remove did: the client it deleted (null when none was recorded), and whether a place went. */
export const removedManagedClient = z.object({
  removed: z.string().nullable(),
  unlisted: z.boolean(),
});
export type RemovedManagedClient = z.infer<typeof removedManagedClient>;
