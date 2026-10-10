import { emitModel } from '@substrat-run/contracts';
import { bikeShopEntities } from './entities.js';
import { bikeShopOperations } from './operations.js';

/**
 * The artifact of record, emitted from the declaration.
 *
 * A file of its own, because it renders who writes each handler (`derive` or `authored`), so it
 * reads the operations, and the operations import the entities. Nothing imports it back.
 *
 * A scaffolded project is not in this repo's `demos/`, so nothing here re-emits a `model.json`
 * for it — `pnpm lint:model` walks `demos/` and `engines/`. What this export is for in a
 * scaffold is the same thing it is for in the reference verticals: one object downstream reads, so
 * the authoring notation stays swappable.
 */
export const bikeShopModel = emitModel(bikeShopEntities, { operations: bikeShopOperations });
