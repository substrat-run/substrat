/**
 * One schema object the kernel derives from a declaration (#2090): the CREATE statement as the
 * kernel emits it, and the table SQLite files it under (`sqlite_master.tbl_name`). The DDL that
 * creates it is assembled from this, so what is checked and what is run cannot differ.
 */
export interface DerivedObject {
  readonly name: string;
  readonly type: 'table' | 'trigger' | 'index';
  /** `sqlite_master.tbl_name`: the table a trigger or index is on; a table's own name. */
  readonly table: string;
  /** The CREATE statement, without its trailing `;` — as `sqlite_master.sql` stores it. */
  readonly sql: string;
}
