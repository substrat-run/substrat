/**
 * ROUND 2 failure harness — the cross-module checks CRM-EFF's validator has to
 * do by hand (their 9–12), plus #696's production bug.
 *
 * Same inversion: every case MUST error, or tsc reports an unused directive.
 */
import { z } from 'zod';
import { defineEntities, defineEnv, defineModel } from './model.js';
import { protocolEngine, workorderEngine } from './engines.js';

const entities = defineEntities({
	contract: { table: 't_contract', fields: z.object({ id: z.string() }) },
});
const env = defineEnv({ SCRIVE_TOKEN: { description: 'token' } });
const operations = {
	'contract/activate': {
		permission: 'p',
		input: z.object({ contractId: z.string() }),
		output: z.object({ contractId: z.string() }),
	},
} as const;

// --- check 9: @consumes(type:) is emitted by a composed engine --------------
defineModel({
	entities,
	env,
	outbound: [],
	permissions: ['customer:write', 'customer:read', 'contract:write', 'p'],
	engines: [protocolEngine],
	operations,
	consumers: {
		'protocol.signed': async () => {},
		'protocol.countersigned': async () => {},
		// @ts-expect-error no composed engine emits 'invoice.issued'
		'invoice.issued': async () => {},
	},
});

// --- #696: half-handled completion group ------------------------------------
// THE EGERYDS PRODUCTION BUG. Consuming `protocol.signed` and not
// `protocol.countersigned` left every multi-party contract pending for ever,
// because completion rides on whoever signs LAST.
defineModel({
	entities,
	env,
	outbound: [],
	permissions: ['customer:write', 'customer:read', 'contract:write', 'p'],
	engines: [protocolEngine],
	operations,
	// @ts-expect-error 'protocol.countersigned' is missing — same completion group
	consumers: {
		'protocol.signed': async (payload) => {
			void payload.complete;
		},
	},
});

// --- #696: the payload is typed, not `unknown` ------------------------------
defineModel({
	entities,
	env,
	outbound: [],
	permissions: ['customer:write', 'customer:read', 'contract:write', 'p'],
	engines: [protocolEngine],
	operations,
	consumers: {
		'protocol.signed': async (payload) => {
			// @ts-expect-error 'competel' is not a field of the engine's payload
			void payload.competel;
		},
		'protocol.countersigned': async () => {},
	},
});

// --- check 10: @guard(predicate:) is exported by a composed engine ----------
defineModel({
	entities,
	env,
	outbound: [],
	permissions: ['customer:write', 'customer:read', 'contract:write', 'p'],
	engines: [protocolEngine],
	operations,
	guards: [
		{
			before: 'contract/activate',
			// @ts-expect-error no composed engine contributes this predicate
			predicate: 'protocol/all-countersigned',
			config: {} as never,
		},
	],
});

// --- check 10: the guard's config must match the engine's declared shape ----
defineModel({
	entities,
	env,
	outbound: [],
	permissions: ['customer:write', 'customer:read', 'contract:write', 'p'],
	engines: [protocolEngine],
	operations,
	guards: [
		{
			before: 'contract/activate',
			predicate: 'protocol/all-signed',
			// @ts-expect-error minSignatures must be a number, and templateKey is required
			config: { templateKey: 'avtal', minSignatures: 'two' },
		},
	],
});

// --- guards still bind to a declared operation ------------------------------
defineModel({
	entities,
	env,
	outbound: [],
	permissions: ['customer:write', 'customer:read', 'contract:write', 'p'],
	engines: [protocolEngine],
	operations,
	guards: [
		{
			// @ts-expect-error 'contract/activte' is not a declared operation
			before: 'contract/activte',
			predicate: 'protocol/all-signed',
			config: { templateKey: 'avtal', minSignatures: 2 },
		},
	],
});

// --- an engine that is NOT composed contributes nothing ---------------------
defineModel({
	entities,
	env,
	outbound: [],
	permissions: ['customer:write', 'customer:read', 'contract:write', 'p'],
	engines: [protocolEngine], // workorder deliberately not composed
	operations,
	consumers: {
		'protocol.signed': async () => {},
		'protocol.countersigned': async () => {},
		// @ts-expect-error workorderEngine is not in `engines`
		'workorder.completed': async () => {},
	},
});
void workorderEngine;
