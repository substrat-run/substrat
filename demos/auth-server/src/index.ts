/**
 * Public barrel for the auth-server demo — the runtime-agnostic pieces (the Better Auth
 * config factory, the schema, the email templates). The Durable Object (`AuthServerDO`)
 * is intentionally NOT re-exported here: it imports `cloudflare:workers` and belongs to the
 * worker build only. The worker imports it directly from `./auth-do.js`.
 */
export { buildAuth, DEMO_CLIENT, seedDemoClient, type Auth, type AuthDeps } from './auth.js';
export { schema } from './auth-schema.generated.js';
export { SCHEMA_STATEMENTS } from '../db/ddl.generated.js';
export { upgradeLegacySchema, type SchemaUpgrade } from '../db/upgrade.js';
export { transportFor, senderFor, resetPasswordEmail, verifyEmail } from './email.js';
export { authServerManifest, AUTH_SERVER_ENV } from './manifest.js';
