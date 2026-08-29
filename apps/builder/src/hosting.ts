/**
 * The local studio's picker catalog — `@substrat-run/model-providers`'
 * disclosure over `process.env`, in the studio's words (§2.1: what is sent).
 */
import { providerCatalog as catalogFrom, type ProviderCatalogEntry } from '@substrat-run/model-providers';
import { SENT } from './disclosure.js';

export type { ProviderCatalogEntry };

export function providerCatalog(): ProviderCatalogEntry[] {
	return catalogFrom(process.env, { sent: SENT });
}
