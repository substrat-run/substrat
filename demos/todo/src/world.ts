/**
 * Todo's sample world (#3108): who is in it, and what they start with. Node-free, because it
 * is not only the dev server's — the kernel's `seatWorld` runs it there and in a hosted
 * seeded preview alike, and does the platform's half itself: a principal per persona, its
 * `role`, the identity link its `sub` signs in by.
 *
 * What is left here is the vertical's: each member claims their account through the
 * operation, never a raw INSERT, and receives the bootstrap grant on their own `owner` entity
 * that their lists hang off — granted as the declared SHAPE (#2071), so a key added to
 * `OWNER_GRANTS` later reaches them at the next reconcile.
 */
import type { SeedWorld } from '@substrat-run/kernel';
import { OWNER_GRANTS } from './manifest.js';
import { PERSONAS } from './personas.js';

export const WORLD: SeedWorld = {
  personas: PERSONAS,
  async build(world) {
    for (const p of world.personas) {
      const seat = world.as(p.sub);
      await seat.invoke('todo/join', { displayName: p.name });
      await world.grantShape({
        to: p.sub,
        entity: { entityType: 'owner', entityId: seat.principal },
        permissions: OWNER_GRANTS,
        grantedBy: p.sub,
      });
    }
  },
};
