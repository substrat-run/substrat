import type { EntityStateDeclaration } from '@substrat-run/contracts';
import { entityStateMigrations } from './entity-state.js';
import { listIndexMigrations, type ListDeclaration } from './list-index.js';
import { searchIndexMigrations, type SearchableDeclaration } from './search-index.js';
import type { SqlMigration } from './scope-host.js';

/**
 * Every migration a module's scope applies, in the order the host applies them: the module's
 * own `migrations`, then the search indexes its `searchables` declare (#827), then the archive and
 * trash columns its `entityStates` declare (#119), then the list indexes its `lists` declare
 * (#811). The derived sets come after the authored ones because their DDL names the tables those
 * create, and the columns come before the list indexes because a partial index names them.
 *
 * The one place that order is written. Both hosts store what this returns as a module's
 * migrations, and `substrat push` calls it (from the vertical's own kernel) to carry the SQL a
 * promote would run (#1677). A module changing only its `searchables` or `lists` runs real
 * schema SQL, so a reader that saw only the authored set would show a promote as changing
 * nothing.
 *
 * Structural, so a `ModuleRegistration` fits and so does a module read back as data.
 */
export function moduleMigrations(registration: {
  readonly manifest: {
    readonly id: string;
    readonly searchables?: readonly SearchableDeclaration[];
    readonly lists?: readonly ListDeclaration[];
    readonly entityStates?: readonly EntityStateDeclaration[];
  };
  readonly migrations?: readonly SqlMigration[];
}): SqlMigration[] {
  const { id, searchables, lists, entityStates } = registration.manifest;
  return [
    ...(registration.migrations ?? []),
    ...searchIndexMigrations(id, searchables),
    ...entityStateMigrations(id, entityStates),
    ...listIndexMigrations(id, lists, entityStates),
  ];
}
