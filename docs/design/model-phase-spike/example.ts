/** A valid model — must typecheck clean. Shaped after the Egeryds slice. */
import { z } from 'zod';
import { defineEntities, defineEnv, defineModel, type Impl } from './model.js';

const entities = defineEntities({
	customer: {
		table: 'vertical_customer',
		fields: z.object({
			id: z.string(),
			customerNumber: z.string(),
			name: z.string(),
			materialMarkupPercent: z.string(),
		}),
		key: ['customerNumber'],
	},
	contactPerson: {
		table: 'vertical_contact_person',
		fields: z.object({ id: z.string(), customerId: z.string(), email: z.string() }),
		parent: 'customer',
	},
	contract: {
		table: 'vertical_contract',
		fields: z.object({ id: z.string(), customerId: z.string(), status: z.string() }),
		parent: 'customer',
	},
});

const env = defineEnv({
	SCRIVE_TOKEN: { description: 'Scrive API token', secret: true },
	MAIL_FROM: { description: 'Sender address', default: 'no-reply@example.com' },
});

export const model = defineModel({
	entities,
	env,
	outbound: ['api.scrive.com', 'api.mail.example'],
	permissions: ['customer:write', 'customer:read', 'contract:write', 'p'],
	operations: {
		'customer/create': {
			permission: 'customer:write',
			input: z.object({ name: z.string(), materialMarkupPercent: z.string() }),
			output: z.object({ id: z.string(), customerNumber: z.string() }),
			http: { method: 'POST', path: '/customers' },
			emits: { entity: 'customer', entityIdFrom: 'id', type: 'fsk.customer-created', piiClass: 'none' },
		},
		'customer/get': {
			permission: 'customer:read',
			input: z.object({ id: z.string() }),
			output: z.object({ id: z.string(), name: z.string(), contacts: z.array(z.string()) }),
			http: { method: 'GET', path: '/customers/{id}' },
		},
		// The #695 shape: a mutation writing a CHILD, whose event is about the PARENT.
		// `entityIdFrom` names the output field carrying the parent's id — the
		// distinction the SDL emitter had to guess at.
		'contact/person-add': {
			permission: 'customer:write',
			input: z.object({ customerId: z.string(), email: z.string() }),
			output: z.object({ id: z.string(), customerId: z.string() }),
			http: { method: 'POST', path: '/customers/{customerId}/contacts' },
			emits: { entity: 'customer', entityIdFrom: 'customerId', type: 'fsk.contact-added', piiClass: 'none' },
		},
		'contract/send-for-signature': {
			permission: 'contract:write',
			input: z.object({ contractId: z.string() }),
			output: z.object({ contractId: z.string(), status: z.string() }),
			emits: { entity: 'contract', entityIdFrom: 'contractId', type: 'fsk.contract-sent', piiClass: 'none' },
			effect: { enabledBy: 'SCRIVE_TOKEN', host: 'api.scrive.com' },
		},
		'contract/sweep-starts': {
			permission: 'contract:write',
			input: z.object({}),
			output: z.object({ advanced: z.number() }),
		},
	},
	schedules: [{ operation: 'contract/sweep-starts', everyMinutes: 60 }],
	projections: [{ entity: 'contract', by: 'contract/send-for-signature' }],
});

/** The generated Impl contract — what a hand-written impl would `satisfies`. */
export type CrmImpl = Impl<typeof model>;

export const impl: CrmImpl = {
	'customer/create': async (input) => ({ id: '01J', customerNumber: `KUND-${input.name.length}` }),
	'customer/get': async (input) => ({ id: input.id, name: 'Brf Solgården', contacts: [] }),
	'contact/person-add': async (input) => ({ id: '01K', customerId: input.customerId }),
	'contract/send-for-signature': async (input) => ({ contractId: input.contractId, status: 'sent' }),
	'contract/sweep-starts': async () => ({ advanced: 3 }),
};
