/** ROUND 2 valid model — composes two engines. Must typecheck clean. */
import { z } from 'zod';
import { defineEntities, defineEnv, defineModel } from './model.js';
import { protocolEngine, workorderEngine } from './engines.js';

const entities = defineEntities({
	contract: { table: 'vertical_contract', fields: z.object({ id: z.string(), status: z.string() }) },
});

const env = defineEnv({ SCRIVE_TOKEN: { description: 'token' } });

export const model = defineModel({
	entities,
	env,
	outbound: ['api.scrive.com'],
	permissions: ['customer:write', 'customer:read', 'contract:write', 'p'],
	engines: [protocolEngine, workorderEngine],
	operations: {
		'contract/activate': {
			permission: 'contract:write',
			input: z.object({ contractId: z.string() }),
			output: z.object({ contractId: z.string(), status: z.string() }),
			emits: { entity: 'contract', entityIdFrom: 'contractId', type: 'fsk.contract-activated', piiClass: 'none' },
		},
	},
	// check 10: predicate name AND its config shape come from engine-protocol.
	guards: [
		{
			before: 'contract/activate',
			predicate: 'protocol/all-signed',
			config: { templateKey: 'avtal', minSignatures: 2 },
		},
	],
	// check 9 + #696: both members of the `signature` completion group handled,
	// and each payload is typed from the engine's own schema.
	consumers: {
		'protocol.signed': async (payload) => {
			// payload.complete is `boolean`, not `unknown` — no cast, no guessing.
			if (payload.complete) void payload.entity.entityId;
		},
		'protocol.countersigned': async (payload) => {
			if (payload.complete) void payload.entity.entityId;
		},
		'workorder.completed': async (payload) => {
			void payload.workorderId;
		},
	},
});
