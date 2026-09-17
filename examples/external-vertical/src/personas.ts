import type { DevPersona } from '@substrat-run/dev-issuer';

/**
 * The local dev cast — the ONE list the issuer and this worker agree on.
 *
 * `npm run dev` starts `@substrat-run/dev-issuer` pointed at this file: a real OpenID
 * Connect provider whose only shortcut is that `/authorize` lists these names instead of
 * asking for a password. `POST /seed` in `worker.ts` reads the same array and links each
 * `sub` to a principal in the identity directory. Neither side holds a copy of the other.
 *
 * Nothing here is a bypass. The issuer asserts a subject and the directory maps it to a
 * principal — the two steps a deployed instance performs against a real issuer — so the
 * login you exercise locally is the one a deployment runs.
 *
 * The import above is type-only, so nothing from the issuer is bundled into the worker.
 */
export const PERSONAS: DevPersona[] = [
  { sub: 'dev|ada', name: 'Ada', email: 'ada@acme.test', note: 'member — may write notes' },
  { sub: 'dev|bo', name: 'Bo', email: 'bo@acme.test', note: 'signed in, holds no role — denied' },
];

/**
 * The identity pool these logins belong to (K-23). Named for the pool rather than the
 * issuer's URL, so moving the issuer's port does not orphan the links the seed wrote.
 */
export const DEV_PROVIDER = 'oidc:dev-issuer';
