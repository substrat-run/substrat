import { defineLifecycles } from '@substrat-run/contracts';
import { workorderEntities } from './entities.js';
import { workorderOperations } from './operations.js';

/**
 * The work order's state machine, declared (#844).
 *
 * It was already here — as `requireStatus(row, 'planned', 'in_progress')` at six
 * call sites, held to the `status` enum in `entities.ts` by nothing. This is the
 * same machine, in one place the compiler checks: a state the column cannot
 * hold, a value the column CAN hold with no state declared for it, an edge to
 * nowhere, or an operation this engine does not declare are all refused.
 *
 * ## Composed by call — so the lifecycle governs the in-scope functions
 *
 * This engine is composed **by call** (`startWorkOrder`, `completeWorkOrder`,
 * …), and a vertical wraps those inside its own transaction. So the check lives
 * with the in-scope function, not with the registered operation: a vertical that
 * composes `completeWorkOrder` gets the invariant, and one that only calls the
 * operation gets the same invariant by the same route.
 *
 * Edges are named by the operation id even where the caller is the in-scope
 * function, because the operation is the stable public name for the verb and
 * the join key everything else uses — `manifest.guards[].before`, the emitted
 * XState machine, the docs diagram.
 *
 * ## What is deliberately not here
 *
 * `workorder/get` and `workorder/list` are reads and no state gates them.
 * **Absence from this declaration means "not governed", never "forbidden"** —
 * the machine describes which mutations a state admits, and an operation it has
 * never heard of is simply not its business.
 *
 * `guards` are also absent, and that is K-38 holding: a guard is wired in the
 * manifest as `{ before, predicate, config }` and evaluated by the kernel. Every
 * edge below names its operation, so a guard on the operation already is a guard
 * on the edge — the emitters join the two rather than making anyone declare it
 * twice.
 */
export const workorderLifecycles = defineLifecycles(
  workorderEntities,
  workorderOperations,
)({
  workorder: {
    field: 'status',
    initial: 'planned',
    states: {
      /** Scheduled, not yet touched. Assignment and early reporting are legal; neither moves it. */
      planned: {
        on: { 'workorder/start': 'in_progress' },
        allow: ['workorder/assign', 'workorder/report-time', 'workorder/report-material'],
      },
      /**
       * The one state that admits substates (K-17).
       *
       * This is where the FSM incumbents' status nuance lives —
       * `awaiting_parts`, `pending_customer_approval` — and where "the vertical
       * is not powerful enough" would otherwise materialise first. The other
       * three admit none: `completed` and `closed` carry billing invariants, and
       * refining `planned` has no case behind it yet.
       */
      in_progress: {
        on: { 'workorder/complete': 'completed' },
        allow: ['workorder/report-time', 'workorder/report-material'],
        extensible: true,
      },
      /** Work done and totalled. The billable lines are fixed; only closing remains. */
      completed: {
        on: { 'workorder/close': 'closed' },
      },
      /** Terminal, and terminal for a reason: closing is what hands the order to invoicing. */
      closed: {
        terminal: true,
      },
    },
  },
});

/** The machine for the `workorder` entity — the shape the evaluator takes. */
export const workorderLifecycle = workorderLifecycles.workorder;
