export {
  shopModule,
  shopManifest,
  SHOP_PERM,
  type ProductRow,
  type VariantRow,
  type OrderRow,
  type OrderLineRow,
} from './module.js';
export {
  buildShopHost,
  seedShop,
  provisionShop,
  shopProvider,
  linkDevPersonas,
  type ShopInstance,
  type ShopWorld,
} from './seed.js';
export { PERSONAS, ROLE_HINTS, PERSONA_PRINCIPALS } from './personas.js';
