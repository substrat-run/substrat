/** The reviewed, priced models a hosted vertical may newly select. */
import { MODEL_CATALOG } from './model-catalog.generated.js';
import { RATE_CARD } from './rate-card.generated.js';
import type { ModelRate } from './pricing.js';

export interface ModelCatalogEntry {
	readonly id: string;
	readonly label: string;
	readonly status: 'active' | 'deprecated';
	readonly servedBy: string;
	/** Index into the rate card emitted by the same generator. */
	readonly rateCardIndex: number;
}

export interface PricedModelCatalogEntry extends ModelCatalogEntry {
	readonly rate: ModelRate;
}

export function pricedModelCatalog(): PricedModelCatalogEntry[] {
	return MODEL_CATALOG.map((entry) => ({ ...entry, rate: RATE_CARD[entry.rateCardIndex]! }));
}

export function selectableModel(id: string): boolean {
	return MODEL_CATALOG.some((entry) => entry.id === id && entry.status === 'active');
}
