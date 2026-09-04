import type { EnvVarSpec } from '@substrat-run/contracts';

/**
 * The auth-server's declared environment — self-describing config so a host or console can
 * render a settings form (placeholder + description) and validate the required keys before
 * deploy. This is the standalone-app manifest: the auth server is its own worker script, so
 * its own secrets are per-deployment (unlike a hosted dispatch vertical, whose one script
 * serves many tenants and so takes per-tenant config through the connection store).
 *
 * The runtime source for the auth server's config surface — the same keys the DO reads off
 * `this.env` (src/auth-do.ts) and the Node dev server reads from process.env. The single
 * declaration (#1206): `src/permissions.ts` re-exports this as `envSpec`, which is what
 * `substrat push` uploads — package.json carries no copy, and `test/envspec.test.ts`
 * guards the wiring.
 */
export const AUTH_SERVER_ENV: EnvVarSpec[] = [
  {
    key: 'PUBLIC_ORIGIN',
    label: 'Issuer origin',
    description: 'Optional pin for the OIDC `issuer`. Leave blank on the platform: the issuer derives itself from the hostname each request arrives on (the install’s platform hostname or a bound custom domain), so discovery is always self-consistent. Set only when the request origin cannot be trusted (e.g. standalone behind a rewriting proxy).',
    placeholder: 'blank ⇒ the hostname the request arrived on',
    required: false,
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
    key: 'ALLOW_SIGNUP',
    label: 'Allow sign-up',
    description: 'Let visitors create their own account (`true`/`false`). Off by default: an issuer that accepts strangers is a decision, not a default. Administrators can always create accounts from the dashboard, and this key is also togglable there — the dashboard writes this same value.',
    placeholder: 'false',
    required: false,
    secret: false,
    group: 'Accounts',
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

/**
 * The capabilities this vertical PROVIDES (manifest `provides`, marketplace-publish.md §4):
 * it serves OIDC discovery/JWKS/token and registers relying parties programmatically
 * (RFC 7591), so an installing app that `requires: ['oidc-issuer']` can be bound to an
 * instance of it — issuer resolved from the instance's hostname, client minted by dynamic
 * registration — instead of hand-copied OIDC_* env (#427). MIRRORED in `package.json`
 * `substrat.provides` (what `substrat push` carries); the drift test guards the pair.
 */
export const AUTH_SERVER_PROVIDES = ['oidc-issuer'];

/** The standalone app manifest — slug + name + declared environment + capabilities. */
export const authServerManifest = {
  slug: 'auth-server',
  name: 'Auth Server',
  envSpec: AUTH_SERVER_ENV,
  provides: AUTH_SERVER_PROVIDES,
};
