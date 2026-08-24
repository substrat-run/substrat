/**
 * Every entity check Shop DECLARES, driven against the handler serving it.
 *
 * One of shop's four narrowed checks is drivable, and the reason the other three
 * are not is worth stating precisely.
 *
 * The probe is a principal with NO role and NO grant — minted here, absent from
 * the seed's cast. That is what makes a pass mean something: the narrowed grant
 * this suite makes is the only authority the probe ever holds, so case 1 cannot
 * be satisfied by a scope-wide key it happened to have.
 *
 * - **`shop/checkout`** narrows `order:read` to the customer being billed, which
 *   is the check that stops a shopper billing someone else. It sits BEHIND the
 *   node gate `cart:checkout`, and a probe holding nothing at the node never
 *   reaches it. `alsoGrant` cannot bridge that: it grants narrowed to the target
 *   entity, and a narrowed grant does not widen to satisfy a node check. So the
 *   operation declares its opening gate and this suite does not drive it — a real
 *   gap in the kit's reach, not a covered case.
 * - **`shop/portal-orders`** and **`shop/my-customer`** declare `narrows`: they
 *   ask per ROW rather than once. The scenario's portal-isolation beat proves
 *   them.
 *
 * What is left is `shop/order`, and it is not a small thing: an order carries a
 * customer's name, address and prices, and a portal customer's whole access to
 * it is one narrowed grant.
 */
import { afterAll, beforeAll } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  permissionKey,
  platformActorId,
  principalId,
  type EntityRef,
} from '@substrat-run/contracts';
import { entityCheckConformanceSuite } from '@substrat-run/contract-tests';
import { ulid } from '@substrat-run/kernel';
import type { SqliteScopeHost } from '@substrat-run/adapter-sqlite';
import { buildShopHost, seedShop, type ShopWorld } from '../src/index.js';
import { conformance } from './conformance.js';

let dir: string;
let host: SqliteScopeHost;
let w: ShopWorld;
let n = 0;

/** No role, no grant, not in the cast — see the header. */
const probe = principalId.parse(ulid());
/** The control-plane dev actor every admin mutation is stamped with (seed.ts). */
const staff = platformActorId.parse(ulid());

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), 'shop-entity-checks-'));
  host = buildShopHost(dir);
  w = await seedShop(host, dir);
});

afterAll(async () => {
  await host.close();
  rmSync(dir, { recursive: true, force: true });
});

entityCheckConformanceSuite(
  conformance.subject,
  conformance.operations,
  async () => {
    const astrid = await host.getScope(w.astrid, w.t1, w.s1);
    return {
      async createEntity(entityType: string) {
        if (entityType === 'customer') {
          const customer = await astrid.invoke<{ id: string }>('shop/create-customer', {
            number: `C-${String(n++).padStart(4, '0')}`,
            name: 'Conformance Probe',
          });
          return customer.id;
        }
        if (entityType === 'order') {
          // An order needs a cart with stock in it, placed for some customer —
          // all of it done as the admin, so the probe's grant is the only thing
          // under test.
          const customer = await astrid.invoke<{ id: string }>('shop/create-customer', {
            number: `O-${String(n++).padStart(4, '0')}`,
            name: 'Order Owner',
          });
          const orderCart = await astrid.invoke<{ id: string }>('shop/create-cart');
          await astrid.invoke('shop/add-to-cart', {
            cartId: orderCart.id,
            variantId: w.chelbesaVariantId,
            qty: 1,
          });
          const placed = await astrid.invoke<{ order: { id: string } }>('shop/checkout', {
            cartId: orderCart.id,
            customerId: customer.id,
          });
          return placed.order.id;
        }
        throw new Error(`no factory for '${entityType}'`);
      },

      async grantOnEntity(permission: string, entity: EntityRef) {
        // The ADMIN grant. Shop's own portal grants are minted per customer at
        // checkout; using that path would prove the bootstrap works, not that the
        // handler narrows.
        await host.admin.grant(staff, {
          principalId: probe,
          permission: permissionKey.parse(permission),
          node: { tenantId: w.t1, scopeId: w.s1 },
          entity,
          grantedBy: w.astrid,
        });
      },

      async invoke(operation: string, input: Record<string, unknown>) {
        const stub = await host.getScope(probe, w.t1, w.s1);
        return stub.invoke(operation, input);
      },
    };
  },
  conformance,
);
