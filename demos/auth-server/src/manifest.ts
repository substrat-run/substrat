import type { EnvVarSpec } from '@substrat-run/contracts';

/**
 * The auth-server's declared environment — self-describing config so a host or console can
 * render a settings form (placeholder + description) and validate the required keys before
 * deploy. This is the standalone-app manifest: the auth server is its own worker script, so
 * its own secrets are per-deployment (unlike a hosted dispatch vertical, whose one script
 * serves many tenants and so takes per-tenant config through the connection store).
 *
 * The runtime source for the auth server's config surface — the same keys the DO reads off
 * `this.env` (src/auth-do.ts) and the Node dev server reads from process.env. It is MIRRORED
 * in `package.json` `substrat.envSpec` (what `substrat push` carries to the registry, since it
 * reads JSON not TS); `test/envspec.test.ts` fails the build if the two ever drift.
 */
export const AUTH_SERVER_ENV: EnvVarSpec[] = [
  {
    key: 'PUBLIC_ORIGIN',
    label: 'Issuer origin',
    description: 'The canonical public URL of this issuer. Becomes the OIDC `issuer` and the base of every discovery/token/JWKS URL.',
    placeholder: 'https://auth.example.com',
    required: true,
    secret: false,
    group: 'Issuer',
  },
  {
    key: 'ADMIN_EMAIL',
    label: 'Admin email',
    description: 'Bootstrap administrator address. With ADMIN_PASSWORD, the first admin is seeded on init — no setup-screen race. Leave both blank to bootstrap via the setup screen instead.',
    placeholder: 'admin@example.com',
    required: false,
    secret: false,
    group: 'Bootstrap',
  },
  {
    key: 'ADMIN_PASSWORD',
    label: 'Admin password',
    description: 'Bootstrap administrator password (at least 8 characters). Delivered as a secret; change it after first sign-in.',
    placeholder: 'at least 8 characters',
    required: false,
    secret: true,
    group: 'Bootstrap',
  },
  {
    key: 'EMAIL_FROM',
    label: 'Sender address',
    description: 'The From address for password-reset and verification mail. Its domain must be onboarded for sending. Absent ⇒ a safe default; without an EMAIL binding, mail is dropped.',
    placeholder: 'no-reply@send.example.com',
    required: false,
    secret: false,
    group: 'Email',
  },
];

/** The standalone app manifest — slug + name + declared environment. */
export const authServerManifest = {
  slug: 'auth-server',
  name: 'Auth Server',
  envSpec: AUTH_SERVER_ENV,
};
