/**
 * ticket0 as it was before the saved-reply trash (#2161), for the suites that build an
 * older desk and upgrade it.
 *
 * Those suites register today's module with an older migration list. Before #2161 nothing
 * declared a trash, and that matters more than a list declaration does: the kernel adds the
 * state column to `ticket0_saved_replies` after the module's own migrations, so an "older"
 * desk built with today's declaration would carry the column BEFORE migration 0027 rebuilds
 * the table — a desk no deployment ever had, which 0027 then leaves without the column and
 * the kernel refuses to open (fail closed). So the older desk declares no trash at all:
 *
 * - no `entityStates` on the manifest, so the kernel adds no column, trigger or purge index;
 * - no purge schedule, which only a trash horizon derives;
 * - the operations re-bound from declarations with `trashed` removed, which is only legal on
 *   an entity that declares a trash. The trash, restore and purge operations stay declared,
 *   and an older desk never calls them.
 *
 * No node-only imports, so the workerd suite reads it too.
 */
import { defineEntities, defineOperations } from '@substrat-run/contracts';
import { operationsFor, type ModuleRegistration } from '@substrat-run/kernel';
import { TICKET0_PERMISSIONS, ticket0Entities, ticket0Operations } from '../spec/model.js';

/** The two moves this PR added. Their `authored` says why a derivable shape is hand-written, and without a trash no shape is. */
const MOVES = new Set(['ticket0/trash-saved-reply', 'ticket0/restore-saved-reply']);

export function withoutTheBin(m: ModuleRegistration): ModuleRegistration {
  const { trash: _trash, ...savedReply } = ticket0Entities.savedReply;
  const entities = defineEntities({ ...ticket0Entities, savedReply });
  const declared = ticket0Operations as Readonly<Record<string, { trashed?: unknown; authored?: unknown; derive?: unknown }>>;
  const declaration = Object.fromEntries(
    Object.entries(declared).map(([name, op]) => {
      const { trashed: _trashed, authored, ...rest } = op;
      return [name, MOVES.has(name) || authored === undefined ? rest : { ...rest, authored }];
    }),
  );
  if (!m.operations) throw new Error('withoutTheBin: the registration binds no operations');
  // The binder writes the derived handlers itself, and refuses one handed to it.
  const authoredHandlers = Object.fromEntries(
    Object.entries(m.operations.handlers).filter(([name]) => declared[name]?.derive === undefined),
  );
  return {
    ...m,
    manifest: {
      ...m.manifest,
      entityStates: undefined,
      schedules: (m.manifest.schedules ?? []).filter((s) => !s.purge),
    },
    ...operationsFor(defineOperations(entities, TICKET0_PERMISSIONS)(declaration as never))(authoredHandlers as never),
  };
}
