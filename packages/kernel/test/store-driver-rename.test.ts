/**
 * K-53's rename, as the two helpers both adapters run: the statements that move a live directory
 * onto the driver names, and the mapping a restore applies to an older dump. The adapters' own
 * suites stage a real pre-rename directory and a rollback; these hold the edges a staging cannot
 * reach cheaply.
 */
import { describe, expect, it } from 'vitest';
import { legacyStoreDriverConflict, legacyStoreDriverRenames } from '../src/index.js';
import { mapLegacyStoreDriverDump } from '../src/store-driver-releases.js';

const RELEASE_COLUMNS = ['kind', 'sha256', 'source_commit', 'uploaded_by', 'uploaded_at'];
const DRIVER_RELEASE_COLUMNS = RELEASE_COLUMNS.map((c) => (c === 'kind' ? 'driver' : c));
const BINDING_COLUMNS = ['vertical_slug', 'binding', 'kind', 'first_version_id'];
const columnsFrom = (tables: Record<string, string[]>) => (table: string) => tables[table];
/** `hasRows` over the tables named as holding rows. */
const rowsIn = (...tables: string[]) => (table: string) => tables.includes(table);

describe('legacyStoreDriverRenames', () => {
  it('renames each old table and its key column, and the binding record’s column', () => {
    const tables = { store_kind_releases: RELEASE_COLUMNS, store_kind_current: ['kind', 'sha256', 'seq'], vertical_scope_stores: BINDING_COLUMNS };
    expect(legacyStoreDriverRenames(Object.keys(tables), columnsFrom(tables), rowsIn('store_kind_releases'))).toEqual([
      'ALTER TABLE store_kind_releases RENAME TO store_driver_releases',
      'ALTER TABLE store_kind_current RENAME TO store_driver_current',
      'ALTER TABLE store_driver_releases RENAME COLUMN kind TO driver',
      'ALTER TABLE store_driver_current RENAME COLUMN kind TO driver',
      'ALTER TABLE vertical_scope_stores RENAME COLUMN kind TO driver',
    ]);
  });

  it('finishes a move a start left half done: the table renamed, its column not', () => {
    const tables = { store_driver_holds: ['kind', 'holder', 'mode', 'expires_at'] };
    expect(legacyStoreDriverRenames(Object.keys(tables), columnsFrom(tables), rowsIn())).toEqual([
      'ALTER TABLE store_driver_holds RENAME COLUMN kind TO driver',
    ]);
  });

  it('moves nothing on a directory already on the driver names, or on an empty one', () => {
    const tables = { store_driver_releases: DRIVER_RELEASE_COLUMNS, vertical_scope_stores: ['vertical_slug', 'binding', 'driver', 'first_version_id'] };
    expect(legacyStoreDriverRenames(Object.keys(tables), columnsFrom(tables), rowsIn('store_driver_releases'))).toEqual([]);
    expect(legacyStoreDriverRenames([], () => undefined, rowsIn())).toEqual([]);
  });

  // A rollback: pre-rename code ran again over a moved directory and created its tables beside.
  describe('a directory holding both names', () => {
    const tables = { store_kind_releases: RELEASE_COLUMNS, store_driver_releases: DRIVER_RELEASE_COLUMNS };

    it('drops the old table when it holds no rows, whatever the new one holds', () => {
      for (const held of [rowsIn(), rowsIn('store_driver_releases')]) {
        expect(legacyStoreDriverRenames(Object.keys(tables), columnsFrom(tables), held)).toEqual(['DROP TABLE store_kind_releases']);
      }
    });

    it('moves the old table’s rows over an empty new one: the rows the rollback wrote are kept', () => {
      expect(legacyStoreDriverRenames(Object.keys(tables), columnsFrom(tables), rowsIn('store_kind_releases'))).toEqual([
        'DROP TABLE store_driver_releases',
        'ALTER TABLE store_kind_releases RENAME TO store_driver_releases',
        'ALTER TABLE store_driver_releases RENAME COLUMN kind TO driver',
      ]);
    });

    it('leaves both where they are when both hold rows: nothing is merged, and nothing with rows is dropped', () => {
      expect(legacyStoreDriverRenames(Object.keys(tables), columnsFrom(tables), rowsIn('store_kind_releases', 'store_driver_releases'))).toEqual([]);
    });
  });
});

describe('legacyStoreDriverConflict', () => {
  const tables = ['store_kind_releases', 'store_driver_releases', 'store_kind_holds', 'store_driver_holds'];

  it('names every table holding rows under both names, and the remedy', () => {
    const line = legacyStoreDriverConflict(tables, rowsIn(...tables));
    expect(line).toContain('store_kind_releases and store_driver_releases, store_kind_holds and store_driver_holds');
    expect(line).toMatch(/refused at restore until one is cleared/);
    expect(line).toMatch(/Restore a directory dump taken before .* or export the store_kind_\* rows/);
  });

  it('is silent when either name is empty, or only one name exists: the start resolves those itself', () => {
    expect(legacyStoreDriverConflict(tables, rowsIn('store_kind_releases', 'store_driver_holds'))).toBeUndefined();
    expect(legacyStoreDriverConflict(['store_kind_releases'], rowsIn('store_kind_releases'))).toBeUndefined();
  });
});

describe('mapLegacyStoreDriverDump', () => {
  it('maps an old table’s name and key column, and the binding record’s column, and leaves the rest', () => {
    const tenants = { name: 'tenants', columns: ['tenant_id', 'kind'], rows: [] };
    const mapped = mapLegacyStoreDriverDump([
      { name: 'store_kind_releases', columns: RELEASE_COLUMNS, rows: [] },
      { name: 'vertical_scope_stores', columns: BINDING_COLUMNS, rows: [] },
      tenants,
    ]);
    expect(mapped.map((t) => [t.name, t.columns])).toEqual([
      ['store_driver_releases', DRIVER_RELEASE_COLUMNS],
      ['vertical_scope_stores', ['vertical_slug', 'binding', 'driver', 'first_version_id']],
      // A `kind` column outside the five tables is another concept, and stays.
      ['tenants', ['tenant_id', 'kind']],
    ]);
    expect(mapped[2]).toBe(tenants);
  });

  it('reads the map by its own keys: a table named for a prototype member is passed on untouched', () => {
    const odd = [{ name: 'constructor', columns: ['kind'], rows: [] }, { name: '__proto__', columns: ['kind'], rows: [] }];
    expect(mapLegacyStoreDriverDump(odd)).toEqual(odd);
  });

  describe('a dump carrying a table under both names (taken after a rollback)', () => {
    const legacy = (rows: unknown[][]) => ({ name: 'store_kind_holds', columns: ['kind', 'holder'], rows });
    const current = (rows: unknown[][]) => ({ name: 'store_driver_holds', columns: ['driver', 'holder'], rows });

    it('leaves out the old table when it holds no rows', () => {
      expect(mapLegacyStoreDriverDump([legacy([]), current([['graph', 'h']])])).toEqual([current([['graph', 'h']])]);
      expect(mapLegacyStoreDriverDump([legacy([]), current([])])).toEqual([current([])]);
    });

    it('takes the old table’s rows, under the new name, when the new one holds none', () => {
      expect(mapLegacyStoreDriverDump([legacy([['graph', 'h']]), current([])])).toEqual([current([['graph', 'h']])]);
    });

    it('refuses it when both hold rows', () => {
      expect(() => mapLegacyStoreDriverDump([legacy([['graph', 'a']]), current([['graph', 'b']])])).toThrow(
        /carries rows in both store_kind_holds and store_driver_holds.*Restore a directory dump taken before/,
      );
    });
  });
});
