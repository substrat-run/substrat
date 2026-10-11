/**
 * The updated stamps the host holds true (#2166) — the vocabulary the model and the host share.
 *
 * An entity declares `stamps: { updated_at: 'updatedAt', updated_by: 'updatedBy' }` in its model
 * (`EntityDef.stamps`), and `model.json` says so. The host holds that claim on every row a call
 * names in `ctx.emit`, not only the rows a derived write touched: after an operation or a
 * consumer, each such row whose entity declares the pair must hold this invocation's `ctx.now()`
 * and principal. `manifestEntities()` derives one of these per such entity; the kernel's
 * `entity-stamps.ts` is the check.
 */
import { z } from 'zod';

/**
 * One entity's updated stamps, as the manifest carries it. `at` is the `updatedAt` column, `by` the
 * `updatedBy` one; at least one is present. `table` and `idColumn` come from the entity registry.
 */
export const updatedStampDeclaration = z
  .object({
    entityType: z.string().min(1),
    table: z.string().min(1),
    idColumn: z.string().min(1),
    at: z.string().min(1).optional(),
    by: z.string().min(1).optional(),
  })
  .refine((d) => d.at !== undefined || d.by !== undefined, { message: 'an updated stamp names `at`, `by` or both' });
export type UpdatedStampDeclaration = z.infer<typeof updatedStampDeclaration>;
