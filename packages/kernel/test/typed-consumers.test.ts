/**
 * #696 — the typed event seam, as a compile-time suite.
 *
 * THIS FILE IS THE FEATURE. The types below are only enforced insofar as
 * something asserts they bite: a type-level constraint fails *permissively*, so
 * a decorative constraint is indistinguishable from a working one if you only
 * ever compile the happy path. Every `@ts-expect-error` here is load-bearing —
 * if a check stops being enforced, `tsc` reports "Unused '@ts-expect-error'
 * directive" and `pnpm --filter @substrat-run/kernel typecheck` goes red.
 *
 * That gate is why `tsconfig.test.json` exists for this package: the default
 * `tsconfig.json` includes only `src`, so before this change nothing in `test/`
 * was typechecked at all.
 *
 * The runtime assertions are deliberately thin. There is no runtime behaviour
 * to test — this change is types only.
 */
import { describe, expect, it } from 'vitest';
import { consumersFor, type ConsumersOf, type EventContract, type ModuleRegistration } from '../src/index.js';

// ---------------------------------------------------------------------------
// What engine-protocol would export. Modelled on the real payloads: both
// completion events carry `complete`, and `signedBy` deliberately DIFFERS —
// on `protocol.countersigned` it is re-pointed at the primary signatory and is
// nullable, while the party who just signed arrives in `countersignedBy`.
// ---------------------------------------------------------------------------

interface SignedPayload {
	instanceId: string;
	entity: { entityType: string; entityId: string };
	signedBy: string;
	/** False while other requested parties are still outstanding. */
	complete: boolean;
}

interface CountersignedPayload {
	instanceId: string;
	entity: { entityType: string; entityId: string };
	/** The PRIMARY signatory, or null if that row is gone. */
	signedBy: string | null;
	countersignedBy: string;
	complete: boolean;
}

type ProtocolEvents = {
	events: {
		'protocol.signed': SignedPayload;
		'protocol.countersigned': CountersignedPayload;
	};
	/** Completion rides on whoever signs LAST — handling one is handling neither. */
	completionGroups: { signature: 'protocol.signed' | 'protocol.countersigned' };
};

type WorkorderEvents = {
	events: { 'workorder.completed': { workorderId: string; completedAt: string } };
};

// A contract is a type, never a value — nothing here exists at runtime.
type _AssertShapes = [ProtocolEvents extends EventContract ? true : never, WorkorderEvents extends EventContract ? true : never];

describe('#696 typed consumers — compile-time', () => {
	it('types the payload instead of handing over `unknown`', () => {
		const seen: string[] = [];
		const consumers = consumersFor<[ProtocolEvents]>()({
			'protocol.signed': async (_ctx, event) => {
				// `complete` is boolean, `signedBy` is string — no cast, no guessing.
				if (event.payload.complete) seen.push(event.payload.signedBy);
			},
			'protocol.countersigned': async (_ctx, event) => {
				// On THIS event `signedBy` is nullable and the actual signer is elsewhere.
				if (event.payload.complete) seen.push(event.payload.countersignedBy);
			},
		});
		expect(Object.keys(consumers).sort()).toEqual(['protocol.countersigned', 'protocol.signed']);
	});

	it('is a pass-through at runtime — types only', () => {
		const handler = async (): Promise<void> => {};
		const consumers = consumersFor<[WorkorderEvents]>()({ 'workorder.completed': handler });
		expect(consumers['workorder.completed']).toBe(handler);
	});
});

// ---------------------------------------------------------------------------
// THE PRODUCTION DEFECT (#696). A vertical consumed `protocol.signed` and not
// `protocol.countersigned`. Completion rides on whoever signs LAST, so a
// two-party contract completes as a COUNTERSIGNATURE — and every multi-party
// contract stayed `pending` for ever while the engine held it `signed`.
// ---------------------------------------------------------------------------
consumersFor<[ProtocolEvents]>()(
	// @ts-expect-error 'protocol.countersigned' is missing — same completion group
	{
		'protocol.signed': async (_ctx, event) => {
			void event.payload.complete;
		},
	},
);

// --- an event type no declared engine emits --------------------------------
consumersFor<[ProtocolEvents]>()({
	'protocol.signed': async () => {},
	'protocol.countersigned': async () => {},
	// @ts-expect-error no declared engine emits 'invoice.issued'
	'invoice.issued': async () => {},
});

// --- an engine that is not declared contributes nothing ---------------------
consumersFor<[ProtocolEvents]>()({
	'protocol.signed': async () => {},
	'protocol.countersigned': async () => {},
	// @ts-expect-error WorkorderEvents is not in the declared list
	'workorder.completed': async () => {},
});

// --- a payload field the producer does not send -----------------------------
consumersFor<[ProtocolEvents]>()({
	'protocol.signed': async (_ctx, event) => {
		// @ts-expect-error 'countersignedBy' is on the COUNTERSIGNED payload only
		void event.payload.countersignedBy;
	},
	'protocol.countersigned': async () => {},
});

// --- the two payloads are genuinely different types -------------------------
consumersFor<[ProtocolEvents]>()({
	'protocol.signed': async () => {},
	'protocol.countersigned': async (_ctx, event) => {
		const signer: string = event.payload.countersignedBy;
		void signer;
		// @ts-expect-error on this event `signedBy` is `string | null`
		const primary: string = event.payload.signedBy;
		void primary;
	},
});

// --- multiple engines compose -----------------------------------------------
consumersFor<[ProtocolEvents, WorkorderEvents]>()({
	'protocol.signed': async () => {},
	'protocol.countersigned': async () => {},
	'workorder.completed': async (_ctx, event) => {
		void event.payload.workorderId;
	},
});

// ---------------------------------------------------------------------------
// BACKWARDS COMPATIBILITY. A module that declares no engines keeps exactly the
// surface it had — an untyped `Record<string, ConsumerHandler>`. Every existing
// engine and vertical must go on compiling untouched, which is what makes this
// change additive (D-28).
// ---------------------------------------------------------------------------
const legacy: ConsumersOf<[]> = {
	'anything.at-all': async (_ctx, event) => {
		// payload is `unknown` here, exactly as before
		void event.payload;
	},
};
void legacy;

const legacyRegistration = {
	consumers: {
		'workorder.completed': async () => {},
	},
} satisfies Pick<ModuleRegistration, 'consumers'>;
void legacyRegistration;
