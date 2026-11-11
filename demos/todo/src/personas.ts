import type { DevPersona } from '@substrat-run/dev-issuer';

/**
 * The local dev cast — the ONE place the issuer and this vertical agree on who exists.
 *
 * `pnpm dev` starts `@substrat-run/dev-issuer` pointed at this file, and the kernel's
 * `seatWorld` reads the same array (through `./world.ts`) to give each persona a principal,
 * its `role` and the identity link its `sub` signs in by. Cleo lives in a second tenant
 * (`elsewhere`), which is the whole point of her: signing in as Cleo lands somewhere else
 * entirely, and no amount of guessing a list id reaches back.
 *
 * Todo is the smallest vertical that is still a real one, and it has no worker — this Node
 * server is all there is. That makes the login here worth getting right rather than faking:
 * it is the only one anybody reading this vertical will see.
 */
export const PERSONAS: DevPersona[] = [
  { sub: 'dev|ada', name: 'Ada', email: 'ada@example.com', note: 'member', role: 'member' },
  { sub: 'dev|bjorn', name: 'Björn', email: 'bjorn@example.com', note: 'member · same tenant as Ada', role: 'member' },
  {
    sub: 'dev|cleo',
    name: 'Cleo',
    email: 'cleo@example.com',
    note: 'member · a different tenant',
    role: 'member',
    elsewhere: true,
  },
];

/** The identity pool these logins belong to (K-23). Central: one issuer, both demo tenants. */
export const DEV_PROVIDER = 'oidc:dev-issuer';
