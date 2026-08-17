/**
 * ROUND 4 — `@erasable` and the PII posture (§12).
 *
 * CRM-EFF calls check 15 "the check the whole PII posture rests on", and calls
 * their own implementation of it crude: it matches the field NAME across all
 * entities, so *"a different `email` that is not erasable would be refused too.
 * Sound in the safe direction, but crude."*
 *
 * The question here is whether a typed model can be EXACT instead — refusing
 * the erasable fields of the entity the event is actually about, and no others.
 */
import { z } from 'zod';
import { defineEntities, defineEnv, defineModel } from './model.js';

const env = defineEnv({ TOKEN: { description: 't' } });

const entities = defineEntities({
	customer: {
		table: 't_customer',
		fields: z.object({ id: z.string(), customerNumber: z.string(), name: z.string() }),
		// A customer may be a private person — #695 §12 found `name` shipping
		// in `fsk.customer-created` with piiClass "none".
		erasable: ['name'],
	},
	contactPerson: {
		table: 't_contact',
		fields: z.object({ id: z.string(), customerId: z.string(), email: z.string() }),
		erasable: ['email'],
	},
	// Deliberately has an `email` field that is NOT erasable — a company inbox.
	office: {
		table: 't_office',
		fields: z.object({ id: z.string(), email: z.string() }),
	},
});

const base = { entities, env, outbound: [], permissions: ['p'] } as const;

// --- check 15: an erasable field cannot ride in an event payload ------------
defineModel({
	...base,
	operations: {
		'customer/create': {
			permission: 'p',
			input: z.object({ name: z.string() }),
			output: z.object({ id: z.string(), customerNumber: z.string(), name: z.string() }),
			emits: {
				entity: 'customer',
				entityIdFrom: 'id',
				type: 'fsk.customer-created',
				piiClass: 'none',
				// @ts-expect-error 'name' is @erasable on customer — immutable events are where erasure cannot reach
				payload: ['id', 'customerNumber', 'name'],
			},
		},
	},
});

// --- the platform's own invariant: piiClass != none REQUIRES subjectId ------
// contracts/events.ts enforces this with a Zod superRefine at runtime:
// "subjectId is required when piiClass is 'direct' — crypto-shredding must be
// able to key the erasure". Here it is at compile time.
defineModel({
	...base,
	operations: {
		'contact/add': {
			permission: 'p',
			input: z.object({ customerId: z.string() }),
			output: z.object({ id: z.string(), customerId: z.string() }),
			// @ts-expect-error piiClass 'direct' without a subjectId to key the erasure
			emits: {
				entity: 'contactPerson',
				entityIdFrom: 'customerId',
				type: 'fsk.contact-added',
				piiClass: 'direct',
			},
		},
	},
});

// --- subjectId must name a real OUTPUT field --------------------------------
defineModel({
	...base,
	operations: {
		'contact/add': {
			permission: 'p',
			input: z.object({ customerId: z.string() }),
			output: z.object({ id: z.string(), customerId: z.string() }),
			emits: {
				entity: 'contactPerson',
				entityIdFrom: 'customerId',
				type: 'fsk.contact-added',
				piiClass: 'direct',
				// @ts-expect-error 'personId' is not a field of the output
				subjectId: 'personId',
			},
		},
	},
});

// --- @erasable itself must name real fields ---------------------------------
defineEntities({
	customer: {
		table: 't_customer',
		fields: z.object({ id: z.string(), name: z.string() }),
		// @ts-expect-error 'emial' is not a field of customer
		erasable: ['emial'],
	},
});

// ---------------------------------------------------------------------------
// THE PRECISION CASE — this MUST COMPILE.
//
// `email` is @erasable on contactPerson. It is NOT erasable on office, which is
// a company inbox. CRM-EFF's name-matching validator refuses this by their own
// admission; resolving through `emits.entity` accepts it, correctly.
//
// This is the difference between "sound in the safe direction, but crude" and
// exact. A crude check trains people to work around it, which is how a PII rule
// stops being obeyed.
// ---------------------------------------------------------------------------
defineModel({
	...base,
	operations: {
		'office/register': {
			permission: 'p',
			input: z.object({ email: z.string() }),
			output: z.object({ id: z.string(), email: z.string() }),
			emits: {
				entity: 'office',
				entityIdFrom: 'id',
				type: 'fsk.office-registered',
				piiClass: 'none',
				payload: ['id', 'email'], // correct: office.email is not erasable
			},
		},
	},
});
