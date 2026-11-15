/**
 * A vertical's declared delegations (#3161) judged against its permission surface: the one
 * reading `lint:permissions` (`tools/permission-diff.mts`), `buildPermissionRegistry` and so
 * `substrat push` all apply, so none of them can admit a delegated key another refuses.
 *
 * A delegation's keys are a ceiling over what the PERSON holds here. A key no module declares can
 * never be held, and a key declared `holder: 'system'` is never a person's, so either one is a
 * ceiling that admits nothing while reading as one that works.
 *
 * Pure and dependency-free, so `tools/` can load it from source.
 */

/** The part of a module a delegation is read from: its manifest's id and `delegations`. */
export interface DelegationSource {
  manifest: {
    id: string;
    delegations?: readonly { actor: string; permissions: readonly string[]; channels?: readonly string[] }[];
  };
}

export interface DelegationOffence {
  module: string;
  actor: string;
  key: string;
  /** `undeclared`: no module declares the key. `reserved`: a module declares it `holder: 'system'`. */
  reason: 'undeclared' | 'reserved';
}

/** Every delegated key that is undeclared or reserved, in module, delegation and key order. */
export function delegationOffences(
  modules: readonly DelegationSource[],
  declared: { has(key: string): boolean },
  reserved: { has(key: string): boolean },
): DelegationOffence[] {
  const out: DelegationOffence[] = [];
  for (const m of modules) {
    for (const d of m.manifest.delegations ?? []) {
      for (const key of d.permissions) {
        if (!declared.has(key)) out.push({ module: m.manifest.id, actor: d.actor, key, reason: 'undeclared' });
        else if (reserved.has(key)) out.push({ module: m.manifest.id, actor: d.actor, key, reason: 'reserved' });
      }
    }
  }
  return out;
}

/** One offence as `lint:permissions` lists it: ``delegation `todo` → `notes:read` ``. */
export function delegationOffenceLine(o: Pick<DelegationOffence, 'actor' | 'key'>): string {
  return `delegation \`${o.actor}\` → \`${o.key}\``;
}

/** The refusal for delegated keys reserved to a system principal, naming the vertical (`where`) and each one. */
export function reservedDelegationMessage(where: string, offences: readonly Pick<DelegationOffence, 'actor' | 'key'>[]): string {
  return (
    `${where} delegates ${offences.length} key(s) reserved to a system principal:\n` +
    offences.map((o) => `    ${delegationOffenceLine(o)}`).join('\n') +
    `\n\n  A delegated call runs as the person, and no person holds a key declared\n` +
    `  \`holder: 'system'\`, so the delegation could never use it. Remove it from the delegation.`
  );
}
