import { describe, it, expect } from 'vitest';
import { referencedTables, orderTablesByForeignKeys } from '../src/dump-order.js';

/** Minimal table shape the orderer needs: name + DDL. */
const t = (name: string, ddl: string) => ({ name, ddl });
const names = (tables: { name: string }[]) => tables.map((x) => x.name);

/** Assert `parent` lands before `child` in the ordered output. */
const before = (ordered: { name: string }[], parent: string, child: string) =>
  expect(names(ordered).indexOf(parent)).toBeLessThan(names(ordered).indexOf(child));

describe('referencedTables — FK targets parsed from DDL', () => {
  it('finds a column-level REFERENCES with a quoted target', () => {
    expect(referencedTables('CREATE TABLE a (id TEXT, v TEXT REFERENCES "crm_vendors"(id))')).toEqual([
      'crm_vendors',
    ]);
  });

  it('finds a table-level FOREIGN KEY clause, bare identifier', () => {
    expect(
      referencedTables('CREATE TABLE a (id TEXT, v TEXT, FOREIGN KEY (v) REFERENCES crm_vendors (id))'),
    ).toEqual(['crm_vendors']);
  });

  it('finds multiple references and every quoting style', () => {
    const ddl =
      'CREATE TABLE a (p TEXT REFERENCES "P"(id), q TEXT REFERENCES `Q`(id), ' +
      'r TEXT REFERENCES [R](id), s TEXT REFERENCES S(id))';
    expect(referencedTables(ddl)).toEqual(['P', 'Q', 'R', 'S']);
  });

  it('returns [] when there are no foreign keys', () => {
    expect(referencedTables('CREATE TABLE a (id TEXT PRIMARY KEY, name TEXT)')).toEqual([]);
  });
});

describe('orderTablesByForeignKeys', () => {
  it('emits the parent before the child even when the child sorts first by name', () => {
    // The exact case from the field report: crm_bank_accounts (child) precedes crm_vendors (parent).
    const tables = [
      t('crm_bank_accounts', 'CREATE TABLE crm_bank_accounts (id TEXT, vendor TEXT REFERENCES crm_vendors(id))'),
      t('crm_vendors', 'CREATE TABLE crm_vendors (id TEXT PRIMARY KEY)'),
    ];
    before(orderTablesByForeignKeys(tables), 'crm_vendors', 'crm_bank_accounts');
  });

  it('resolves a multi-level chain (a → b → c) parents-first', () => {
    const tables = [
      t('a', 'CREATE TABLE a (id TEXT, b TEXT REFERENCES b(id))'),
      t('b', 'CREATE TABLE b (id TEXT, c TEXT REFERENCES c(id))'),
      t('c', 'CREATE TABLE c (id TEXT PRIMARY KEY)'),
    ];
    const ordered = orderTablesByForeignKeys(tables);
    expect(names(ordered)).toEqual(['c', 'b', 'a']);
  });

  it('preserves input order among tables with no FK relationship (stable)', () => {
    const tables = [t('z', 'CREATE TABLE z (id TEXT)'), t('m', 'CREATE TABLE m (id TEXT)'), t('a', 'CREATE TABLE a (id TEXT)')];
    expect(names(orderTablesByForeignKeys(tables))).toEqual(['z', 'm', 'a']);
  });

  it('tolerates a self-reference without looping or dropping the table', () => {
    const tables = [
      t('tree', 'CREATE TABLE tree (id TEXT PRIMARY KEY, parent TEXT REFERENCES tree(id))'),
      t('leaf', 'CREATE TABLE leaf (id TEXT, tree TEXT REFERENCES tree(id))'),
    ];
    const ordered = orderTablesByForeignKeys(tables);
    expect(names(ordered).sort()).toEqual(['leaf', 'tree']);
    before(ordered, 'tree', 'leaf');
  });

  it('tolerates a cycle (a ↔ b) — total order, no infinite loop, both kept', () => {
    const tables = [
      t('a', 'CREATE TABLE a (id TEXT, b TEXT REFERENCES b(id))'),
      t('b', 'CREATE TABLE b (id TEXT, a TEXT REFERENCES a(id))'),
    ];
    const ordered = orderTablesByForeignKeys(tables);
    expect(names(ordered).sort()).toEqual(['a', 'b']);
  });

  it('ignores references to tables not present in the dump (partial dump)', () => {
    const tables = [t('a', 'CREATE TABLE a (id TEXT, ext TEXT REFERENCES not_in_dump(id))')];
    expect(names(orderTablesByForeignKeys(tables))).toEqual(['a']);
  });

  it('does not mutate the input array', () => {
    const tables = [
      t('child', 'CREATE TABLE child (id TEXT, p TEXT REFERENCES parent(id))'),
      t('parent', 'CREATE TABLE parent (id TEXT PRIMARY KEY)'),
    ];
    const snapshot = names(tables);
    orderTablesByForeignKeys(tables);
    expect(names(tables)).toEqual(snapshot);
  });
});
