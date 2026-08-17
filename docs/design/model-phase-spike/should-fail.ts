/**
 * The half that decides the spike. Every case below MUST be a compile error.
 *
 * `@ts-expect-error` inverts the test: if a check fails to bite, tsc reports
 * "Unused '@ts-expect-error' directive" and this file goes red. So a clean
 * typecheck of this file means every listed check is genuinely enforced.
 */
import { z } from 'zod';
import { defineEntities, defineEnv, defineModel, type Impl } from './model.js';

const env = defineEnv({ SCRIVE_TOKEN: { description: 'token' } });

// --- check 1: @relation(parent:) names a declared entity --------------------
defineEntities({
	customer: { table: 't_customer', fields: z.object({ id: z.string() }) },
	contact: {
		table: 't_contact',
		fields: z.object({ id: z.string() }),
		// @ts-expect-error 'custmer' is not a declared entity
		parent: 'custmer',
	},
});

// --- check 2: @entity(key:) names fields that exist -------------------------
defineEntities({
	customer: {
		table: 't_customer',
		fields: z.object({ id: z.string(), customerNumber: z.string() }),
		// @ts-expect-error 'custmerNumber' is not a field of this entity
		key: ['custmerNumber'],
	},
});

const entities = defineEntities({
	customer: { table: 't_customer', fields: z.object({ id: z.string() }) },
	contract: { table: 't_contract', fields: z.object({ id: z.string() }), parent: 'customer' },
});

// --- check 3: @emits(entity:) names a declared entity -----------------------
defineModel({
	entities,
	env,
	outbound: [],
	permissions: ['customer:write', 'customer:read', 'contract:write', 'p'],
	operations: {
		'x/create': {
			permission: 'p',
			input: z.object({}),
			output: z.object({ id: z.string() }),
			// @ts-expect-error 'invoice' is not a declared entity
			emits: { entity: 'invoice', entityIdFrom: 'id', type: 'x.created', piiClass: 'none' },
		},
	},
});

// --- check 6: entityIdFrom names a field of the OUTPUT ----------------------
// THE #695 CASE: 18 operations emitted `entityId: String(result.id)` on an
// object with no `id` — they answer with contractId / runId / instanceId.
defineModel({
	entities,
	env,
	outbound: [],
	permissions: ['customer:write', 'customer:read', 'contract:write', 'p'],
	operations: {
		'contract/advance': {
			permission: 'p',
			input: z.object({ contractId: z.string() }),
			output: z.object({ contractId: z.string(), status: z.string() }),
			// @ts-expect-error output has no 'id' — it answers with contractId
			emits: { entity: 'contract', entityIdFrom: 'id', type: 'fsk.contract-advanced', piiClass: 'none' },
		},
	},
});

// --- check 18: {var} in the path names a real input field -------------------
defineModel({
	entities,
	env,
	outbound: [],
	permissions: ['customer:write', 'customer:read', 'contract:write', 'p'],
	operations: {
		'customer/get': {
			permission: 'p',
			input: z.object({ id: z.string() }),
			output: z.object({ id: z.string() }),
			// @ts-expect-error {customerId} is not an input field — input has 'id'
			http: { method: 'GET', path: '/customers/{customerId}' },
		},
	},
});

// --- check 8: @effect(enabledBy:) names a declared env key ------------------
defineModel({
	entities,
	env,
	outbound: ['api.scrive.com'],
	permissions: ['customer:write', 'customer:read', 'contract:write', 'p'],
	operations: {
		'contract/send': {
			permission: 'p',
			input: z.object({}),
			output: z.object({ id: z.string() }),
			// @ts-expect-error SCRIV_TOKEN is not a declared env key
			effect: { enabledBy: 'SCRIV_TOKEN', host: 'api.scrive.com' },
		},
	},
});

// --- check 21: @outbound(hosts:) ⊇ every @effect(host:) ---------------------
defineModel({
	entities,
	env,
	outbound: ['api.scrive.com'],
	permissions: ['customer:write', 'customer:read', 'contract:write', 'p'],
	operations: {
		'contract/send': {
			permission: 'p',
			input: z.object({}),
			output: z.object({ id: z.string() }),
			// @ts-expect-error api.mail.example is not in outbound — would 403 in prod
			effect: { enabledBy: 'SCRIVE_TOKEN', host: 'api.mail.example' },
		},
	},
});

// --- check 7: @schedule names a declared operation --------------------------
defineModel({
	entities,
	env,
	outbound: [],
	permissions: ['customer:write', 'customer:read', 'contract:write', 'p'],
	operations: {
		'contract/sweep': { permission: 'p', input: z.object({}), output: z.object({ n: z.number() }) },
	},
	// @ts-expect-error 'contract/swep' is not a declared operation
	schedules: [{ operation: 'contract/swep', everyMinutes: 60 }],
});

// --- check 4: @projected(by:) resolves to a declared operation --------------
defineModel({
	entities,
	env,
	outbound: [],
	permissions: ['customer:write', 'customer:read', 'contract:write', 'p'],
	operations: {
		'contract/recompute': { permission: 'p', input: z.object({}), output: z.object({ n: z.number() }) },
	},
	// @ts-expect-error 'contract/recomptue' is not a declared operation
	projections: [{ entity: 'contract', by: 'contract/recomptue' }],
});

// --- the Impl drift case (CRM-EFF's `satisfies Impl`) -----------------------
// Their finding: customer/get returned four fields where the schema promised ten.
const m = defineModel({
	entities,
	env,
	outbound: [],
	permissions: ['customer:write', 'customer:read', 'contract:write', 'p'],
	operations: {
		'customer/get': {
			permission: 'p',
			input: z.object({ id: z.string() }),
			output: z.object({ id: z.string(), name: z.string(), contacts: z.array(z.string()) }),
		},
	},
});

const impl: Impl<typeof m> = {
	// @ts-expect-error missing 'contacts' — the impl drifted from the declared return
	'customer/get': async (input) => ({ id: input.id, name: 'x' }),
};
void impl;
