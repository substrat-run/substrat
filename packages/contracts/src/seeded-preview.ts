import { z } from 'zod';
import { scopeId, tenantId } from './ids.js';

/**
 * A SEEDED preview (#3108): a clean-room preview holding the vertical's own sample world, whose
 * people sign in by picking a persona. This is the vocabulary between the control plane, which
 * creates the preview and runs the picker, and the vertical's deployment, which seats the world.
 *
 *   - `POST /internal/seed-world` — seat the world's personas in one scope: a principal each, its
 *     role, and the link its `sub` signs in by; and, when `build` is set, the records they start
 *     with. Safe to repeat. Refused for any scope that is not a clean-room preview: a persona link
 *     on a production scope, or on a fork of one, would be a way in that nobody was invited by.
 *   - `POST /internal/personas` — the personas that scope offers, for the picker. Read-only.
 *
 * A deployment that declares no world answers both 501.
 */
export const SEED_WORLD_PATH = '/internal/seed-world';
/**
 * Where the control plane's persona issuer lives: one issuer per preview, at
 * `<control plane origin>/persona/<preview scope id>`, so a token minted for one preview names an
 * issuer no other preview trusts.
 */
export const PERSONA_ISSUER_PATH = '/persona';
export const personaIssuerUrl = (controlPlaneOrigin: string, previewScopeId: string): string =>
  `${controlPlaneOrigin.replace(/\/+$/, '')}${PERSONA_ISSUER_PATH}/${previewScopeId}`;
/**
 * Whether an issuer URL is a persona issuer's (#3145): its path is exactly
 * `${PERSONA_ISSUER_PATH}/<scope id>`. Only a seeded preview is delivered one, and the studio shows
 * it in a cross-site frame, so its deployment's cookies have to work there.
 */
export function isPersonaIssuer(issuer: string): boolean {
  let path: string;
  try {
    path = new URL(issuer).pathname.replace(/\/+$/, '');
  } catch {
    return false;
  }
  const prefix = `${PERSONA_ISSUER_PATH}/`;
  return path.startsWith(prefix) && scopeId.safeParse(path.slice(prefix.length)).success;
}
export const PERSONAS_PATH = '/internal/personas';

export const seedWorldBody = z
  .object({
    tenantId,
    scopeId,
    /**
     * The platform's word that the scope is new, so the world's records are built too. A deployment
     * also builds a reused scope whose data holds none of the world's people yet; a build is not
     * idempotent, so it never builds where they are already seated.
     */
    build: z.boolean(),
  })
  .strict();
export type SeedWorldBody = z.infer<typeof seedWorldBody>;

export const personasBody = z.object({ tenantId, scopeId }).strict();
export type PersonasBody = z.infer<typeof personasBody>;

/** A persona as the picker shows it. Its `sub` is what the persona issuer signs. */
export const seededPersona = z.object({
  sub: z.string().min(1).max(200),
  name: z.string().min(1).max(200),
  email: z.string().email().max(320),
  role: z.string().min(1).max(200).optional(),
  note: z.string().max(500).optional(),
});
export type SeededPersona = z.infer<typeof seededPersona>;

export const seededPersonas = z.object({ personas: z.array(seededPersona).max(100) });
export type SeededPersonas = z.infer<typeof seededPersonas>;
