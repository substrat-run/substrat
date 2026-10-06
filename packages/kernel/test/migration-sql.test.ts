import { describe, expect, it } from 'vitest';
import { assertJournalDumpCoherent } from '../src/index.js';

/** Whether a dump's journal is consistent with its own shape (#2066 r3). */
describe('assertJournalDumpCoherent', () => {
  const ddl = (withDigest: boolean) =>
    `CREATE TABLE _substrat_migrations (module_id TEXT, version TEXT${withDigest ? ', sql_digest TEXT' : ''})`;
  it('accepts a journal whose DDL and columns agree, either way', () => {
    expect(() => assertJournalDumpCoherent([{ name: '_substrat_migrations', ddl: ddl(false), columns: ['module_id', 'version'] }])).not.toThrow();
    expect(() =>
      assertJournalDumpCoherent([{ name: '_substrat_migrations', ddl: ddl(true), columns: ['module_id', 'version', 'sql_digest'] }]),
    ).not.toThrow();
  });
  it('refuses one whose DDL and columns disagree, in both directions', () => {
    expect(() => assertJournalDumpCoherent([{ name: '_substrat_migrations', ddl: ddl(true), columns: ['module_id', 'version'] }])).toThrow(
      'declares sql_digest in its DDL but carries no such column',
    );
    expect(() =>
      assertJournalDumpCoherent([{ name: '_Substrat_Migrations', ddl: ddl(false), columns: ['module_id', 'version', 'SQL_DIGEST'] }]),
    ).toThrow('carries sql_digest but its DDL does not declare it');
  });
});
