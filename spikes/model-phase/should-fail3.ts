/**
 * ROUND 3 — the directives I predicted would push back.
 *
 * `@gate`, `@narrows`, and the migration lifecycle. Includes the honest
 * negative: check 5 splits in half, and only one half is a type.
 */
import { z } from 'zod';
import { defineEntities, defineEnv, defineModel } from './model.js';

const env = defineEnv({ TOKEN: { description: 't' } });
const entities = defineEntities({
	contract: { table: 't_contract', fields: z.object({ id: z.string(), amount: z.string() }) },
});
const base = { entities, env, outbound: [], permissions: ['contract:read', 'contract:amounts'] } as const;

// --- @gate: the gated field must exist on the OUTPUT ------------------------
defineModel({
	...base,
	operations: {
		'contract/get': {
			permission: 'contract:read',
			input: z.object({ id: z.string() }),
			output: z.object({ id: z.string(), amount: z.string() }),
			// @ts-expect-error 'amunt' is not a field of the output
			gates: { amunt: 'contract:amounts' },
		},
	},
});

// --- @gate: the gating permission must be DECLARED --------------------------
defineModel({
	...base,
	operations: {
		'contract/get': {
			permission: 'contract:read',
			input: z.object({ id: z.string() }),
			output: z.object({ id: z.string(), amount: z.string() }),
			// @ts-expect-error 'contract:amount' is not a declared permission (typo for :amounts)
			gates: { amount: 'contract:amount' },
		},
	},
});

// --- the leading permission must be declared too ----------------------------
defineModel({
	...base,
	operations: {
		'contract/get': {
			// @ts-expect-error 'contract:raed' is not a declared permission
			permission: 'contract:raed',
			input: z.object({ id: z.string() }),
			output: z.object({ id: z.string() }),
		},
	},
});

// --- check 14: an operation has `permission` OR `narrows`, never both -------
defineModel({
	...base,
	operations: {
		'contract/list': {
			// @ts-expect-error narrows and a leading permission are mutually exclusive
			permission: 'contract:read',
			input: z.object({}),
			output: z.object({ rows: z.array(z.string()) }),
			narrows: { reason: 'salesperson sees own contracts' },
		},
	},
});

// --- check 14: ...and never neither -----------------------------------------
defineModel({
	...base,
	operations: {
		// @ts-expect-error neither permission nor narrows — rule 5 unenforced
		'contract/list': {
			input: z.object({}),
			output: z.object({ rows: z.array(z.string()) }),
		},
	},
});

// --- @narrows requires a reason ---------------------------------------------
defineModel({
	...base,
	operations: {
		'contract/list': {
			input: z.object({}),
			output: z.object({ rows: z.array(z.string()) }),
			// @ts-expect-error a bare `narrows: true` carries no reason
			narrows: true,
		},
	},
});

// --- check 5a: @renamedFrom must NOT name a CURRENT field -------------------
defineEntities({
	contract: {
		table: 't_contract',
		fields: z.object({ id: z.string(), totalAmount: z.string() }),
		// @ts-expect-error 'totlAmount' is not a current field — the rename target must exist
		renamedFrom: [{ to: 'totlAmount', from: 'amount' }],
	},
});

// ---------------------------------------------------------------------------
// THE HONEST NEGATIVE — check 5b is NOT typeable.
//
// `@renamedFrom(name:)` must also name something that EXISTS IN THE PREVIOUS
// JOURNAL. The type system sees one version of the model; it has no access to
// history. The declaration below is nonsense — `amont` was never a field of
// anything — and it compiles, correctly, because nothing in the current model
// contradicts it.
//
// This check stays in the emitter, reading journal.json. It is the clearest
// case of a validator rule that a type system cannot absorb, and it is the
// reason the emitter keeps a validate step rather than deleting it.
// ---------------------------------------------------------------------------
defineEntities({
	contract: {
		table: 't_contract',
		fields: z.object({ id: z.string(), amount: z.string() }),
		renamedFrom: [{ to: 'amount', from: 'amont' }], // no such prior field — compiles anyway
	},
});
