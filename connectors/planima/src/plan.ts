import { z } from 'zod';
import { money, moneyAmount, type Money } from '@substrat-run/contracts';
import type { PlanimaAction, PlanimaBuilding, PlanimaComponent, PlanimaFacility } from './api.js';

/**
 * Provider rows → the neutral facts that cross into a scope.
 *
 * Two conversions happen here and nowhere else, and both are the kind of thing that is
 * wrong forever if it is wrong once:
 *
 * 1. **Every number that is money becomes a decimal string.** Planima sends JSON
 *    numbers — `total_price: 125000.5` — and a JSON number is an IEEE double. Substrat
 *    money is decimal strings via `@substrat-run/contracts`, never floats (K-14), so
 *    the conversion belongs at the edge where the double arrives rather than in every
 *    consumer that later adds two of them up.
 * 2. **`snake_case` becomes `camelCase`.** The provider's spelling stops at this file.
 *    A vertical reading `zip_code` off a payload has Planima's API shape leaking into
 *    its own vocabulary, and the day Planima renames a field, every consumer changes.
 *
 * What does NOT happen here is interpretation. A status stays whatever string arrived,
 * a category stays a name, and nothing is mapped to a vertical's vocabulary — that is
 * the consumer's layer, and a connector that did it would be a vertical wearing a
 * connector's clothes.
 */

/**
 * A JSON number as an exact decimal string.
 *
 * `toFixed(6)` matches `moneyAmount`'s six-decimal ceiling exactly, which is what makes
 * this total rather than best-effort: the contract cannot represent more precision than
 * this produces, so there is no input that formats correctly here and fails to parse
 * there. Trailing zeros are trimmed so `125000.50` and `125000.5` are the same string —
 * a content hash over these values is a change detector, and two spellings of one
 * number would make an unchanged plan look changed on every sweep.
 *
 * Two inputs are refused rather than coerced, because both would produce a string that
 * lies: a non-finite number has no decimal form at all, and `toFixed` switches to
 * exponential notation at 1e21, which `moneyAmount`'s regex rejects downstream — far
 * from here, with no clue which field caused it.
 */
export function decimalOf(value: number, what: string): string {
  if (!Number.isFinite(value)) {
    throw new Error(`Planima sent a non-finite number for ${what}: ${String(value)}`);
  }
  if (Math.abs(value) >= 1e21) {
    throw new Error(`Planima sent an out-of-range number for ${what}: ${String(value)}`);
  }
  const fixed = value.toFixed(6);
  const trimmed = fixed.includes('.') ? fixed.replace(/0+$/, '').replace(/\.$/, '') : fixed;
  // `(-0).toFixed(6)` is `"-0.000000"`, which trims to `"-0"` — a legal `moneyAmount`
  // that is nonetheless a second spelling of zero, and therefore a phantom change.
  return trimmed === '-0' ? '0' : trimmed;
}

/** A nullable JSON number as nullable money in the plan's currency. */
const moneyOrNull = (value: number | null, currency: string, what: string): Money | null =>
  value === null ? null : money.parse({ amount: decimalOf(value, what), currency });

/** A nullable JSON number as a nullable decimal string — for rates and quantities, which are not money. */
const decimalOrNull = (value: number | null, what: string): string | null =>
  value === null ? null : decimalOf(value, what);

// ---------------------------------------------------------------------------
// The facts. These are the published shape — parsed on the way OUT, before every
// invoke, for the reason `returns()` exists on an engine seam.
// ---------------------------------------------------------------------------

/** A decimal string, in the same six-decimal shape money uses, for values that are not money. */
export const planimaDecimal = z.string().regex(/^-?\d+(\.\d{1,6})?$/);

export const planimaFacilityFact = z.object({
  id: z.number().int(),
  name: z.string(),
  address: z.string().nullable(),
  zipCode: z.string().nullable(),
  region: z.string().nullable(),
  tags: z.array(z.string()),
  /** Residential area (sv. BOA) in m². */
  residentialArea: planimaDecimal.nullable(),
  /** Non-residential area (sv. LOA) in m². */
  nonResidentialArea: planimaDecimal.nullable(),
  yearOfConstruction: z.number().int().nullable(),
  description: z.string().nullable(),
});
export type PlanimaFacilityFact = z.infer<typeof planimaFacilityFact>;

export const planimaBuildingFact = z.object({
  id: z.number().int(),
  facilityId: z.number().int(),
  name: z.string(),
  address: z.string().nullable(),
  zipCode: z.string().nullable(),
  region: z.string().nullable(),
  yearOfConstruction: z.number().int().nullable(),
});
export type PlanimaBuildingFact = z.infer<typeof planimaBuildingFact>;

export const planimaComponentFact = z.object({
  id: z.number().int(),
  facilityId: z.number().int(),
  buildingId: z.number().int().nullable(),
  name: z.string(),
  /** The component DEFINITION's name — what kind of thing this is, as against what it is called. */
  component: z.string().nullable(),
  category: z.string().nullable(),
  type: z.string().nullable(),
  amount: planimaDecimal.nullable(),
  unit: z.string().nullable(),
});
export type PlanimaComponentFact = z.infer<typeof planimaComponentFact>;

export const planimaActionFact = z.object({
  id: z.number().int(),
  facilityId: z.number().int(),
  buildingId: z.number().int().nullable(),
  componentId: z.number().int().nullable(),
  projectId: z.number().int().nullable(),
  name: z.string(),
  /** The year the action is to be performed — the axis a maintenance plan is read along. */
  year: z.number().int(),
  /**
   * Planima's own status string, passed through unmapped.
   *
   * Not an enum, deliberately: Planima types this `string` in its own spec even though
   * it documents eight values for the matching filter, so a ninth is a product change
   * rather than a protocol break. `PLANIMA_ACTION_STATUSES` is exported for a consumer
   * that wants to branch, but nothing here refuses an unknown one — a whole tenant's
   * plan failing to land because one action moved to a new status is a worse outcome
   * than a consumer seeing a string it does not recognise.
   */
  status: z.string(),
  description: z.string().nullable(),
  amount: planimaDecimal.nullable(),
  unit: z.string().nullable(),
  unitPrice: money.nullable(),
  totalPrice: money.nullable(),
  totalPriceInclVat: money.nullable(),
  /** Set once the action is completed. */
  finalCost: money.nullable(),
  /** A decimal FRACTION, as Planima states it: `0.25` is 25 %. */
  vatRate: planimaDecimal.nullable(),
  /** The fraction of the cost treated as investment rather than maintenance. */
  investmentRate: planimaDecimal.nullable(),
  isEnergySaving: z.boolean(),
  co2EquivalentKg: planimaDecimal.nullable(),
  /** Top-level category name, and the facility/building NAMES Planima denormalizes onto an action. */
  category: z.string().nullable(),
  location: z.string().nullable(),
  building: z.string().nullable(),
  tags: z.array(z.string()),
  updatedAt: z.string().nullable(),
});
export type PlanimaActionFact = z.infer<typeof planimaActionFact>;

// ---------------------------------------------------------------------------
// Conversion
// ---------------------------------------------------------------------------

export const facilityFact = (row: PlanimaFacility): PlanimaFacilityFact => ({
  id: row.id,
  name: row.name,
  address: row.address,
  zipCode: row.zip_code,
  region: row.region,
  tags: row.tags,
  residentialArea: decimalOrNull(row.residential_area, `facility ${row.id} residential_area`),
  nonResidentialArea: decimalOrNull(row.non_residential_area, `facility ${row.id} non_residential_area`),
  yearOfConstruction: row.year_of_construction === null ? null : Math.trunc(row.year_of_construction),
  description: row.description,
});

export const buildingFact = (row: PlanimaBuilding): PlanimaBuildingFact => ({
  id: row.id,
  facilityId: row.facility_id,
  name: row.name,
  address: row.address,
  zipCode: row.zip_code,
  region: row.region,
  yearOfConstruction: row.year_of_construction === null ? null : Math.trunc(row.year_of_construction),
});

export const componentFact = (row: PlanimaComponent): PlanimaComponentFact => ({
  id: row.id,
  facilityId: row.facility_id,
  buildingId: row.building_id === null ? null : Math.trunc(row.building_id),
  name: row.name,
  component: row.component,
  category: row.category,
  type: row.type,
  amount: decimalOrNull(row.amount, `component ${row.id} amount`),
  unit: row.unit,
});

export const actionFact = (row: PlanimaAction, currency: string): PlanimaActionFact => ({
  id: row.id,
  // Planima nests the facility on an action rather than sending a flat id. The
  // connector always fetches actions BY facility, so the id is known either way — but
  // reading it from the row keeps the fact self-describing for a consumer that stores
  // one action without its page.
  facilityId: row.facility?.id ?? 0,
  buildingId: row.building_id === null ? null : Math.trunc(row.building_id),
  componentId: row.component_id === null ? null : Math.trunc(row.component_id),
  projectId: row.project_id === null ? null : Math.trunc(row.project_id),
  name: row.name,
  year: row.year,
  status: row.status,
  description: row.description,
  amount: decimalOrNull(row.amount, `action ${row.id} amount`),
  unit: row.unit,
  unitPrice: moneyOrNull(row.unit_price, currency, `action ${row.id} unit_price`),
  totalPrice: moneyOrNull(row.total_price, currency, `action ${row.id} total_price`),
  totalPriceInclVat: moneyOrNull(row.total_price_incl_vat, currency, `action ${row.id} total_price_incl_vat`),
  finalCost: moneyOrNull(row.final_cost, currency, `action ${row.id} final_cost`),
  vatRate: decimalOrNull(row.vat_rate, `action ${row.id} vat_rate`),
  investmentRate: decimalOrNull(row.investment_rate, `action ${row.id} investment_rate`),
  isEnergySaving: row.is_energy_saving,
  co2EquivalentKg: decimalOrNull(row.co2_equivalent, `action ${row.id} co2_equivalent`),
  category: row.category,
  location: row.location,
  building: row.building,
  tags: row.tags,
  updatedAt: row.updated_at,
});

/**
 * An action fact with the facility id filled in from the fetch that produced it.
 *
 * `Action.facility` is documented as present, but it is one optional nesting away from
 * being absent, and a fact whose `facilityId` is `0` is worse than one that throws:
 * it silently attaches a real action to a facility that does not exist. The caller
 * always knows which facility it asked for, so it says so.
 */
export const actionFactIn = (row: PlanimaAction, facilityId: number, currency: string): PlanimaActionFact => ({
  ...actionFact(row, currency),
  facilityId,
});

/** The moneyAmount brand, re-exported so a consumer can parse a bare amount without importing contracts twice. */
export { moneyAmount };
