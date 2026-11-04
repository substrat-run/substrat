import { moduleMigrations } from './module-migrations.js';

/**
 * What a scope host's class says it registers (#2351). `defineScopeDO` puts a static method under
 * this key on the class it returns, so the control plane can read the migrations a bundle's
 * worker entry registers by evaluating the bundle, rather than trusting the copy the push
 * declared. `Symbol.for`, so the key is the same whichever copy of the kernel a bundle carries.
 */
export const REGISTERED_MIGRATIONS = Symbol.for('substrat.registeredMigrations');

/** One migration a host registers, in the shape a push declares one (`DeclaredMigration`). */
export interface RegisteredMigration {
  moduleId: string;
  version: string;
  sql: string;
  moves?: Readonly<Record<string, string>>;
  discards?: Readonly<Record<string, string>>;
}

/** A `moves` or `discards` record as a push carries it: absent when it declares none. */
function declared(key: 'moves' | 'discards', record: Readonly<Record<string, string>> | undefined) {
  return record && Object.keys(record).length > 0 ? { [key]: record } : {};
}

/**
 * Every migration these modules register, module by module in the order given, each module's in
 * the order the host applies them (`moduleMigrations`, the list both hosts store). An empty
 * `moves` or `discards` is left off, as `substrat push` leaves it off, so a registered set and a
 * declared one compare field for field.
 */
export function registeredMigrationsOf(modules: readonly Parameters<typeof moduleMigrations>[0][]): RegisteredMigration[] {
  return modules.flatMap((registration) =>
    moduleMigrations(registration).map((m) => ({
      moduleId: registration.manifest.id,
      version: m.version,
      sql: m.sql,
      ...declared('moves', m.moves),
      ...declared('discards', m.discards),
    })),
  );
}
