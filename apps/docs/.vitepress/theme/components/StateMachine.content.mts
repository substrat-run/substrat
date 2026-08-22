/**
 * The engine state machines, and their markdown twins.
 *
 * Five engine pages drew this by hand in ASCII, and two of the five had already
 * drifted: booking's picture showed neither `cancel` nor `no-show`, and
 * protocol's omitted `voided` entirely. That is the argument for reading the
 * machine rather than redrawing it.
 *
 * ## Two sources, and the difference is stated, not hidden
 *
 * `workorder`, `booking` and `invoicing` declare a lifecycle, so their machine
 * is read from the emitted `model.json` — an artifact `lint:model --check`
 * already gates. Those diagrams cannot drift from the code.
 *
 * `absence`, `protocol` and `invites` declare no lifecycle yet, so their machine
 * is written out below, transcribed from the engine's own status enum and its
 * `requireStatus` call sites. **Nothing gates those three.** They carry
 * `declared: false`, the page says so under the figure, and the fix is not a
 * better comment here — it is `defineLifecycles` in those three engines, after
 * which the entry swaps to `fromModel` and this note goes away.
 */
import booking from '../../../../../engines/booking/model.json' with { type: 'json' };
import invoicing from '../../../../../engines/invoicing/model.json' with { type: 'json' };
import workorder from '../../../../../engines/workorder/model.json' with { type: 'json' };
import { altFrom, fromModel, type Machine } from './state-machine.mjs';

export interface Diagram {
  /** The entity the machine governs — its name on the page. */
  readonly entity: string;
  readonly machine: Machine;
  /** True when the machine came from an emitted, CI-gated `model.json`. */
  readonly declared: boolean;
}

/** Transcribed, not emitted — see the header. */
const absence: Machine = {
  field: 'status',
  initial: 'requested',
  states: {
    requested: {
      on: {
        'absence/approve': 'approved',
        'absence/reject': 'rejected',
        'absence/cancel': 'cancelled',
      },
    },
    approved: { on: { 'absence/cancel': 'cancelled' } },
    rejected: { terminal: true },
    cancelled: { terminal: true },
  },
};

/** Transcribed, not emitted — see the header. */
const protocol: Machine = {
  field: 'status',
  initial: 'open',
  states: {
    open: {
      on: {
        'protocol/request-signatures': 'pending_signature',
        'protocol/sign': 'signed',
        'protocol/void': 'voided',
      },
    },
    pending_signature: {
      on: {
        'protocol/complete-signing': 'signed',
        'protocol/cancel-signature-requests': 'open',
        'protocol/void': 'voided',
      },
    },
    signed: { on: { 'protocol/void': 'voided' } },
    voided: { terminal: true },
  },
};

/** Transcribed, not emitted — see the header. */
const invites: Machine = {
  field: 'state',
  initial: 'invited',
  states: {
    invited: {
      on: {
        'invites/accept': 'accepted',
        'invites/revoke': 'revoked',
        'invites/expire': 'expired',
      },
    },
    accepted: { terminal: true },
    revoked: { terminal: true },
    expired: { terminal: true },
  },
};

export const DIAGRAMS: Record<string, Diagram> = {
  workorder: { entity: 'workorder', machine: fromModel(workorder, 'workorder'), declared: true },
  booking: { entity: 'reservation', machine: fromModel(booking, 'reservation'), declared: true },
  invoicing: { entity: 'underlag', machine: fromModel(invoicing, 'underlag'), declared: true },
  absence: { entity: 'absence request', machine: absence, declared: false },
  protocol: { entity: 'protocol', machine: protocol, declared: false },
  invites: { entity: 'invitation', machine: invites, declared: false },
};

export function diagramFor(engine: string): Diagram {
  const d = DIAGRAMS[engine];
  if (!d) throw new Error(`no state machine registered for engine '${engine}'`);
  return d;
}

export const emittedNote =
  'Drawn from the engine’s declared lifecycle in model.json — the same artifact ' +
  'lint:model --check gates, so this picture cannot drift from the code.';

export const transcribedNote =
  'This engine declares no lifecycle yet, so the machine above is transcribed from its ' +
  'status enum and guard clauses. Nothing re-checks it — treat it as documentation, not ' +
  'as the contract.';

export function alt(props: Record<string, string>): string {
  const d = diagramFor(props.engine ?? '');
  return [
    altFrom(d.machine, d.entity),
    '',
    d.declared ? emittedNote : transcribedNote,
  ].join('\n');
}
