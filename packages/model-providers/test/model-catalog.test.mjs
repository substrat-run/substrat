import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { expect, it } from 'vitest';
import { catalogFromAllowlist } from '../scripts/model-catalog.mjs';
import { MODEL_CATALOG } from '../src/model-catalog.generated.ts';
import { RATE_CARD } from '../src/rate-card.generated.ts';

it('generates the reviewed picker deterministically from exact priced card rows', () => {
	const allowlist = JSON.parse(readFileSync(fileURLToPath(new URL('../model-catalog.allowlist.json', import.meta.url)), 'utf8'));
	const emitted = catalogFromAllowlist(allowlist, RATE_CARD);
	expect(emitted).toEqual(MODEL_CATALOG);
	expect(catalogFromAllowlist(allowlist, RATE_CARD)).toEqual(emitted);
	expect(() => catalogFromAllowlist([...allowlist, { id: 'cloudflare:missing', status: 'active', servedBy: 'Cloudflare Workers AI' }], RATE_CARD))
		.toThrow(/no exact rate-card entry/);
});
