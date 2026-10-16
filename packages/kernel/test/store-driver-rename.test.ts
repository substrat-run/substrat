/**
 * K-53's rename, as the two helpers both adapters run: the statements that move a live directory
 * onto the driver names, and the mapping a restore applies to an older dump. The adapters' own
 * suites stage a real pre-rename directory; these hold the edges a staging cannot reach cheaply.
 */
import { describe, expect, it } from 'vitest';
import { legacyStoreDriverRenames } from '../src/index.js';
import { mapLegacyStoreDriverDump } from '../src/store-driver-releases.js';

const RELEASE_COLUMNS = ['kind', 'sha256', 'source_commit', 'uploaded_by', 'uploaded_at'];
const BINDING_COLUMNS = ['vertical_slug', 'binding', 'kind', 'first_version_id'];
const columnsFrom = (tables: Record<string, string[]>) => (table: string) => tables[table];

describe('legacyStoreDriverRenames', () => {
  it('renames each old table and its key column, and the binding record’s column', () => {
    const tables = { store_kind_releases: RELEASE_COLUMNS, store_kind_current: ['kind', 'sha256', 'seq'], vertical_scope_stores: BINDING_COLUMNS };
    expect(legacyStoreDriverRenames(Object.keys(tables), columnsFrom(tables))).toEqual([
      'ALTER TABLE store_kind_releases RENAME TO store_driver_releases',
      'ALTER TABLE store_kind_current RENAME TO store_driver_current',
      'ALTER TABLE store_driver_releases RENAME COLUMN kind TO driver',
      'ALTER TABLE store_driver_current RENAME COLUMN kind TO driver',
      'ALTER TABLE vertical_scope_stores RENAME COLUMN kind TO driver',
    ]);
  });

  it('finishes a move a start left half done: the table renamed, its column not', () => {
    const tables = { store_driver_holds: ['kind', 'holder', 'mode', 'expires_at'] };
    expect(legacyStoreDriverRenames(Object.keys(tables), columnsFrom(tables))).toEqual([
      'ALTER TABLE store_driver_holds RENAME COLUMN kind TO driver',
    ]);
  });

  it('moves nothing on a directory already on the driver names, or on an empty one', () => {
    const tables = { store_driver_releases: RELEASE_COLUMNS.map((c) => (c === 'kind' ? 'driver' : c)), vertical_scope_stores: ['vertical_slug', 'binding', 'driver', 'first_version_id'] };
    expect(legacyStoreDriverRenames(Object.keys(tables), columnsFrom(tables))).toEqual([]);
    expect(legacyStoreDriverRenames([], () => undefined)).toEqual([]);
  });

  it('leaves an old table whose new name already exists where it is: nothing is merged or dropped', () => {
    const tables = { store_kind_releases: RELEASE_COLUMNS, store_driver_releases: RELEASE_COLUMNS.map((c) => (c === 'kind' ? 'driver' : c)) };
    expect(legacyStoreDriverRenames(Object.keys(tables), columnsFrom(tables))).toEqual([]);
  });
});

describe('mapLegacyStoreDriverDump', () => {
  it('maps an old table’s name and key column, and the binding record’s column, and leaves the rest', () => {
    const tenants = { name: 'tenants', columns: ['tenant_id', 'kind'] };
    const mapped = mapLegacyStoreDriverDump([
      { name: 'store_kind_releases', columns: RELEASE_COLUMNS },
      { name: 'vertical_scope_stores', columns: BINDING_COLUMNS },
      tenants,
    ]);
    expect(mapped.map((t) => [t.name, t.columns])).toEqual([
      ['store_driver_releases', ['driver', 'sha256', 'source_commit', 'uploaded_by', 'uploaded_at']],
      ['vertical_scope_stores', ['vertical_slug', 'binding', 'driver', 'first_version_id']],
      // A `kind` column outside the five tables is another concept, and stays.
      ['tenants', ['tenant_id', 'kind']],
    ]);
    expect(mapped[2]).toBe(tenants);
  });

  it('refuses a dump that carries a table under both names', () => {
    expect(() =>
      mapLegacyStoreDriverDump([
        { name: 'store_kind_holds', columns: ['kind'] },
        { name: 'store_driver_holds', columns: ['driver'] },
      ]),
    ).toThrow(/carries both store_kind_holds and store_driver_holds/);
  });
});
