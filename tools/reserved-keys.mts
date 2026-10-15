/**
 * Keys no person may hold — the half of `lint:permissions` that refuses a role granting one.
 *
 * A vertical's person-facing surface is its `ROLES` and its `ENTITY_GRANTS` shapes (what a
 * principal is handed per entity). A module's SYSTEM principal is a different declaration:
 * `manifest.schedules[].permissions` (`system:<module>`) and `manifest.peers[].permissions`
 * (`vertical:<slug>`). So "a system-only key" needs no new concept in the surface: it may appear
 * in the second place and never in the first.
 *
 * This is NOT the purge-only notion of K-45 (`entity-trash.ts`): that scopes a key a system
 * principal already holds to one schedule's call. It says where a system principal may USE a key,
 * not that a person may not be given it. Nothing else models "never a person's".
 *
 * A table, not a declared marker, while there is one entry. The follow-up, when a second key
 * wants this, is a `holder: 'system'` on the permission declaration so an engine states it where
 * it declares the key.
 */

/** Key → why no person may hold it. */
export const RESERVED_TO_SYSTEM: Readonly<Record<string, string>> = {
  'assistant:run':
    "it drives a run (the lease, the assistant's side of a thread, a tool's execution) and belongs to the assistant host's system principal; a person holding it could write the assistant's side of their own thread",
};

export interface ReservedKeyOffence {
  /** Where it was granted: `role <key>` or `grant shape on <entityType>`. */
  where: string;
  key: string;
}

/** Every person-facing grant of a reserved key, in the order the surface lists them. */
export function reservedKeyOffences(surface: {
  roles: { key: string; permissions: string[] }[];
  grants: { entityType: string; permissions: string[] }[];
}): ReservedKeyOffence[] {
  const out: ReservedKeyOffence[] = [];
  for (const r of surface.roles) {
    for (const p of r.permissions) if (p in RESERVED_TO_SYSTEM) out.push({ where: `role ${r.key}`, key: p });
  }
  for (const g of surface.grants) {
    for (const p of g.permissions) {
      if (p in RESERVED_TO_SYSTEM) out.push({ where: `grant shape on ${g.entityType}`, key: p });
    }
  }
  return out;
}

/** The refusal's text, naming the vertical, the file, each grant and the remedy. */
export function reservedKeyMessage(rel: string, entry: string, offences: ReservedKeyOffence[]): string {
  return (
    `${rel}/${entry} grants a key reserved to a system principal to a person's role or grant shape:\n` +
    offences.map((o) => `    ${o.where} → ${o.key}: ${RESERVED_TO_SYSTEM[o.key]}`).join('\n') +
    `\n\n  Remedy: take the key out of the role or shape. A module's own system principal gets it\n` +
    `  from a schedule's \`permissions\` (or a peer's), never from a role.`
  );
}
