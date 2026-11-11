/**
 * The cast the picker shows — the ONE fact the issuer and the app it authenticates for
 * must agree on.
 *
 * `sub` is the join. The issuer mints ID tokens carrying it; the vertical's seed links it
 * to a principal in its identity directory (`linkIdentity`). Both read the same array, so
 * neither can drift from the other, and both do the ordinary production thing: an issuer
 * asserts a subject, a directory maps it to a principal.
 *
 * Keep `sub` values stable and human-readable (`dev|anna`) — they end up in a seeded
 * directory that survives across restarts, and a reader looking at an identity link should
 * be able to tell who it is.
 */
export interface DevPersona {
  /** The OIDC `sub` this persona authenticates as. Stable across restarts. */
  sub: string;
  /** Shown in the picker, and sent as the `name` claim. */
  name: string;
  /** Sent as the `email` claim. */
  email: string;
  /** A one-line hint under the name in the picker — "office-admin", "portal customer @ …". */
  note?: string;
  /**
   * The role key, from the vertical's `ROLES`, this persona holds where it is seated
   * (`seatWorld` in `@substrat-run/kernel`, #3108). Absent: no scope-wide role.
   */
  role?: string;
  /** Belongs to another tenant — the outsider an isolation scenario turns away. */
  elsewhere?: boolean;
}
