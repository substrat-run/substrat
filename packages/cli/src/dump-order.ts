/**
 * FK-safe ordering for scope dumps.
 *
 * A dump's `tables` array carries no ordering guarantee — the server export sorts
 * by table NAME, and `readDump` enumerates `sqlite_master` in creation order. Neither
 * says anything about foreign keys: a child table (`crm_bank_accounts`) can precede
 * its parent (`crm_vendors`), and a loader that inserts in array order then trips
 * `FOREIGN KEY constraint failed` on the child's first row.
 *
 * The adapters defer FK checks to a transaction commit (their "suspenders"), but not
 * every loader does — `writeSqlite` below inserts row-by-row with no deferral, and an
 * older deployed control plane predates the deferral fix. So we make the dump FK-safe
 * BY CONSTRUCTION here (the "belt"): order every table after the tables it references,
 * so parents insert before children whatever the loader does.
 *
 * Deferral still covers what a total order cannot express — FK cycles and
 * self-references — so a cycle isn't an error here: we break it deterministically and
 * lean on the loader's deferral for the within-cycle rows.
 */

/** Table names referenced by this table's DDL (`... REFERENCES <name> ...`). */
export function referencedTables(ddl: string): string[] {
  // SQLite identifiers after REFERENCES may be bare or quoted with " ` [] or '.
  const re = /\bREFERENCES\s+(?:"([^"]+)"|`([^`]+)`|\[([^\]]+)\]|'([^']+)'|([A-Za-z_][\w$]*))/gi;
  const out: string[] = [];
  for (let m = re.exec(ddl); m; m = re.exec(ddl)) {
    // Exactly one alternation group captures the identifier; the last is a bare word,
    // so the coalesced result is always a string (the `!` satisfies the checker).
    out.push((m[1] ?? m[2] ?? m[3] ?? m[4] ?? m[5])!);
  }
  return out;
}

/**
 * Order tables so every FK target precedes the table referencing it. Stable
 * (independent tables keep their input order), total, and cycle-tolerant.
 */
export function orderTablesByForeignKeys<T extends { name: string; ddl: string }>(tables: T[]): T[] {
  const present = new Set(tables.map((t) => t.name));
  // Each table's in-dump FK targets, minus self-references and targets not in the dump.
  const deps = new Map<string, Set<string>>(
    tables.map((t) => [
      t.name,
      new Set(referencedTables(t.ddl).filter((r) => r !== t.name && present.has(r))),
    ]),
  );

  const ordered: T[] = [];
  const emitted = new Set<string>();
  const remaining = tables.slice();
  while (remaining.length > 0) {
    let progressed = false;
    for (let i = 0; i < remaining.length; ) {
      const t = remaining[i]!;
      if ([...deps.get(t.name)!].every((d) => emitted.has(d))) {
        ordered.push(t);
        emitted.add(t.name);
        remaining.splice(i, 1);
        progressed = true;
      } else {
        i++;
      }
    }
    // No table became ready this pass → a cycle among the rest. Force-emit the first
    // remaining (deterministic, preserves input order); deferral covers its FK rows.
    if (!progressed) {
      const t = remaining.shift() as T;
      ordered.push(t);
      emitted.add(t.name);
    }
  }
  return ordered;
}
