/**
 * The shop's sample world: who is in it (`src/personas.ts`), and what they start with. Node-free,
 * because it is not only the dev server's. `seatWorld` runs it there, and a seeded preview of
 * the deployed app runs it in the worker (`workerDoor({ world: WORLD })`), so the two hold the
 * same people and the same records. The platform does its half itself: a principal per persona,
 * its `role`, and the identity link its `sub` signs in by.
 *
 * What is left here is the vertical's: records are made through the operations, never raw SQL,
 * so the seed runs the same checks and emits the same events the app does; and each portal
 * customer is given the `customer` shape on their own record, the grant everything they can see
 * hangs off.
 */
import type { SeedWorld, WorldBuilder } from '@substrat-run/kernel';
import { portalPerms } from './provision.js';
import { PERSONAS } from './personas.js';

/** The records the shop starts with, which the dev seed remembers in `cast.json`. */
export interface ShopRecords {
  lisbethId: string;
  ottoId: string;
  crescentId: string;
  bianchiId: string;
}

/** Build the shop's records. The other shop (`elsewhere`) starts empty, so it answers null. */
export async function buildShop(world: WorldBuilder): Promise<ShopRecords | null> {
  if (!world.personas.some((p) => p.sub === 'dev|greta')) return null;
  const greta = world.as('dev|greta');
  const lisbeth = await greta.invoke<{ id: string }>('shop/create-customer', {
    number: '2001',
    name: 'Lisbeth Sandell',
    phone: '070-123 45 67',
  });
  const otto = await greta.invoke<{ id: string }>('shop/create-customer', { number: '2002', name: 'Otto Vinge' });
  const crescent = await greta.invoke<{ id: string }>('shop/register-bike', {
    customerId: lisbeth.id,
    label: 'Crescent Elina 3-vxl',
    frameNo: 'CR-88412',
  });
  const bianchi = await greta.invoke<{ id: string }>('shop/register-bike', { customerId: otto.id, label: 'Bianchi Oltre XR3' });
  for (const price of [
    { article: 'labor', description: 'Mechanic time', unit: 'hour', priceAmount: '495', minQty: '0.5' },
    { article: 'shop-supplies', description: 'Workshop supplies', unit: 'ea', priceAmount: '15', internal: true },
    { article: 'tube-28', description: 'Inner tube 28"', unit: 'ea', priceAmount: '89' },
    { article: 'chain-9s', description: 'Chain, 9-speed', unit: 'ea', priceAmount: '249' },
  ]) {
    await greta.invoke('shop/upsert-price', price);
  }
  // Each portal customer holds the `customer` shape on their OWN record only; the walk
  // workorder → bike → customer does the rest.
  for (const [sub, customerId] of [
    ['dev|lisbeth', lisbeth.id],
    ['dev|otto', otto.id],
  ] as const) {
    await world.grantShape({ to: sub, entity: { entityType: 'customer', entityId: customerId }, permissions: portalPerms, grantedBy: 'dev|greta' });
  }
  return { lisbethId: lisbeth.id, ottoId: otto.id, crescentId: crescent.id, bianchiId: bianchi.id };
}

export const WORLD: SeedWorld = {
  personas: PERSONAS,
  async build(world) {
    await buildShop(world);
  },
};
