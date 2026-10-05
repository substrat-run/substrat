/**
 * The check every kernel-derived DDL runs on a name before interpolating it (#827, #811, #119).
 *
 * SQL identifiers reach the DDL by interpolation — there is no parameter form for a table or
 * column name — so every one is checked first. The inputs are declarations rather than user
 * input, but a declaration is still a string somebody typed, and "it came from the manifest"
 * is exactly the reasoning that makes an injection a surprise.
 */
export const SQL_IDENTIFIER = /^[A-Za-z_][A-Za-z0-9_]*$/;

/** `value`, or a throw naming the declaration (`where`) and the role it plays (`kind`). */
export function assertSqlIdentifier(area: string, kind: string, value: string, where: string): string {
  if (!SQL_IDENTIFIER.test(value)) {
    throw new Error(`${area}: ${where} names ${kind} '${value}', which is not a plain SQL identifier`);
  }
  return value;
}
