/**
 * Connections as one list over three stores (spec/console-redesign.md §2): the password
 * database, the upstream provider registry, and BankID. Nothing here is new storage — a
 * connection is a name and a strategy laid over a row that already exists, and "which
 * applications are enabled for it" is a reading of each client's `metadata.signIn`.
 *
 * Pure, and with no import from `api.ts`'s functions, so the policy arithmetic below is the
 * same kind of module `sign-in-draft.ts` is: the rules about what a toggle writes sit in one
 * place rather than in a component.
 */
import type { BankIdSettings, ConfiguredProvider, ProviderCatalogueEntry, RegisteredClient } from '../../api';

/** The reserved ids (`src/sign-in-policy.ts`), read here as the connections they name. */
import { DATABASE_ID } from './policy';

export { DATABASE_ID };
export { enabledFor, followsEveryUpstream, routedDomains, toggledMetadata } from './policy';
export const BANKID_ID = 'bankid' as const;

export type Connection =
  | { kind: 'database'; id: typeof DATABASE_ID; name: string; strategy: 'database' }
  | { kind: 'bankid'; id: typeof BANKID_ID; name: string; strategy: 'bankid'; settings: BankIdSettings }
  | {
      kind: 'provider';
      id: string;
      name: string;
      /** The catalogue id, or `oidc` for a generic upstream the catalogue does not name. */
      strategy: string;
      entry: ProviderCatalogueEntry | null;
      provider: ConfiguredProvider;
    };

/**
 * Whether BankID is on the login screen, and if not, why — one answer for the connections
 * list and the BankID connection, matching `publicBankIdFrom` on the server: a transport, and
 * through the relay a connection test that passed.
 */
export function bankIdStatus(settings: BankIdSettings): string {
  if (settings.disabled) return 'Disabled';
  if (settings.transport === 'none') return 'Not offered — this deployment cannot present the certificate';
  if (settings.probe?.ok) return 'Enabled';
  if (settings.probe) {
    const failed = `connection test failed at ${settings.probe.stage ?? 'an unknown stage'}`;
    // Only the relay's path waits for a passing test; a deployment presenting the certificate
    // itself still offers BankID, and the failure is a warning about it.
    return settings.transport === 'hop' ? `Not offered — ${failed}` : `Enabled — ${failed}`;
  }
  return settings.transport === 'hop' ? 'Not offered — test the connection' : 'Enabled — not tested';
}

export function providerConnection(entry: ProviderCatalogueEntry | null, provider: ConfiguredProvider): Connection {
  return {
    kind: 'provider',
    id: provider.id,
    name: entry?.label ?? provider.label ?? provider.id,
    strategy: entry ? entry.id : 'oidc',
    entry,
    provider,
  };
}

/** Every connection this issuer has, database first: it is the one that always exists. */
export function connectionsFrom(
  catalogue: readonly ProviderCatalogueEntry[],
  providers: readonly ConfiguredProvider[],
  bankid: BankIdSettings | null,
): Connection[] {
  return [
    { kind: 'database', id: DATABASE_ID, name: 'Username-Password', strategy: 'database' },
    ...providers.map((p) => providerConnection(catalogue.find((e) => e.id === p.id) ?? null, p)),
    ...(bankid ? [{ kind: 'bankid' as const, id: BANKID_ID, name: 'BankID', strategy: 'bankid' as const, settings: bankid }] : []),
  ];
}

/**
 * One status for a connection, in the words its own screen uses, plus how loudly to say it.
 * The database connection has no off switch of its own: whether an application takes
 * passwords is that application's policy, which the Applications tab shows.
 */
export function connectionStatus(c: Connection): { label: string; tone: 'success' | 'warning' | 'neutral' } {
  if (c.kind === 'database') return { label: 'Enabled', tone: 'success' };
  if (c.kind === 'bankid') {
    const label = bankIdStatus(c.settings);
    return { label, tone: c.settings.disabled ? 'neutral' : label === 'Enabled' ? 'success' : 'warning' };
  }
  if (c.provider.disabled) return { label: 'Disabled', tone: 'neutral' };
  if (c.provider.attention) return { label: 'Not offered — save again', tone: 'warning' };
  return { label: 'Enabled', tone: 'success' };
}

/** A machine client has no sign-in, so no connection can be enabled for it (#2267). */
export const signsIn = (client: RegisteredClient): boolean => client.application_type !== 'machine';
