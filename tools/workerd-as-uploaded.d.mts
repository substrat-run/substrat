/** Types for `workerd-as-uploaded.mjs` — a vertical's workerd config, as the platform uploads it (#1902). */
export function asUploaded(
  dir: string,
  derived: Record<string, unknown>,
): Promise<Record<string, unknown> & { vars: Record<string, string> }>;
