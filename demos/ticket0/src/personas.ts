import type { DevPersona } from '@substrat-run/dev-issuer';

/**
 * The local dev cast — the ONE place the issuer and this vertical agree on who exists.
 *
 * Two desks, and signing in as Dana or Omar lands in Kestrel's, not Substrat's. That is
 * the whole point of them: no amount of guessing a conversation id reaches back across.
 */
export const PERSONAS: DevPersona[] = [
  { sub: 'dev|markus', name: 'Markus', email: 'markus@substrat.example', note: 'desk-admin · Substrat · sees the money' },
  { sub: 'dev|anna', name: 'Anna', email: 'anna@substrat.example', note: 'agent · Substrat · cannot see the money' },
  { sub: 'dev|priya', name: 'Priya', email: 'priya@customer.example', note: 'customer · Substrat · sees only her own' },
  { sub: 'dev|dana', name: 'Dana', email: 'dana@kestrel.example', note: 'desk-admin · Kestrel · a different desk' },
  { sub: 'dev|omar', name: 'Omar', email: 'omar@kestrel.example', note: 'agent · Kestrel · a different desk' },
];

/** The identity pool these logins belong to. Central: one issuer, both demo desks. */
export const DEV_PROVIDER = 'oidc:dev-issuer';
