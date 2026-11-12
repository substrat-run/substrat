/**
 * A vertical's sample world, seated the same way wherever it runs (#3108).
 *
 * A vertical declares WHO its sample world holds — its personas, each with the role key it
 * plays — and, optionally, how to BUILD the records they work on. Everything between those two
 * is the platform's: a principal per persona, the identity link that lets the persona's `sub`
 * sign in as it, and the role. It lives here so that the local dev server and a hosted seeded
 * preview run one function, and a persona added to the cast cannot be seated in one and
 * forgotten in the other — the hand-written persona-to-principal table each seed used to keep
 * skipped an unlisted persona without a word.
 *
 * Node-free, like the rest of the kernel: `build` runs in a vertical's worker as well as in a
 * node harness, so it reaches the world only through the operations `as(sub)` invokes and the
 * one platform act an operation cannot make itself, {@link WorldBuilder.grantShape}.
 *
 * Re-seating is safe. A persona whose `sub` already resolves in the tenant keeps its
 * principal and is not handed its role again, so a dev server may seat on every boot and only
 * the first finds anything to do; `build` runs only when the caller says the scope is fresh.
 */
import {
  principalId,
  type EntityRef,
  type PermissionKey,
  type PlatformActorId,
  type PrincipalId,
  type ScopeId,
  type TenantId,
} from '@substrat-run/contracts';
import type { ScopeHost } from './scope-host.js';
import { ulid } from './ulid.js';

/** One person in a vertical's sample world. `@substrat-run/dev-issuer`'s `DevPersona` is one. */
export interface WorldPersona {
  /** The OIDC `sub` the persona signs in as. The join between the issuer and the directory. */
  readonly sub: string;
  readonly name: string;
  /** Carried to every invoke `as(sub)` makes, as the door carries a sign-in's verified address. */
  readonly email: string;
  /**
   * The role key, from the vertical's own `ROLES`, the persona holds in the scope. Absent: no
   * scope-wide role — a portal customer whose access is a grant on their own record, which
   * `build` makes once that record exists.
   */
  readonly role?: string;
  /**
   * Belongs to a DIFFERENT tenant: the outsider a local world keeps so its isolation scenario
   * has someone to turn away. A world with one scope (a hosted preview) leaves them out.
   */
  readonly elsewhere?: boolean;
  /** A one-line hint a persona picker shows under the name. */
  readonly note?: string;
}

/** A persona, seated: its principal, and an invoker acting as it. */
export interface WorldSeat {
  readonly principal: PrincipalId;
  invoke<O = unknown, I = unknown>(operation: string, input?: I): Promise<O>;
}

export interface WorldBuilder {
  /**
   * The personas seated in THIS scope — the home cast, or the outsiders in their own tenant —
   * so one `build` serves both, and a world with one scope never reaches for an absent outsider.
   */
  readonly personas: readonly WorldPersona[];
  /** Act as a seated persona. Throws for a `sub` this seating did not seat. */
  as(sub: string): WorldSeat;
  /**
   * The bootstrap grant an operation cannot make: a declared entity-grant shape, given to a
   * persona by a platform actor — a person's rights over their own record, from which every
   * `ctx.grant` they make later delegates.
   */
  grantShape(input: {
    to: string;
    entity: EntityRef;
    permissions: readonly PermissionKey[];
    grantedBy: string;
  }): Promise<void>;
}

/** What a vertical declares: its cast and, optionally, the records they start with. */
export interface SeedWorld {
  readonly personas: readonly WorldPersona[];
  build?(world: WorldBuilder): Promise<void>;
}

/**
 * Where a world is seated: the directory a persona's `sub` signs in through, and the scope it
 * works in. {@link seatWorld} seats into a host's own admin directory, as a node harness has
 * one; a deployed vertical has none (its host is scope-local), so it passes its own: the
 * identity store its sign-in door reads, and the scope-local verbs for the role and the grant.
 */
export interface WorldSeating {
  /** The principal `sub` is already linked to here, or null. Never claims anything. */
  resolve(sub: string): Promise<PrincipalId | null>;
  /**
   * The principal a persona not linked here gets. Absent: a fresh ulid. A deployed preview
   * derives it from the scope and the `sub` instead (see `personaPrincipal`), because each push
   * is a new script whose identity store starts empty while the scope's data is carried: the
   * same persona has to come back as the same principal, or it loses everything it built.
   */
  principalFor?(sub: string): Promise<PrincipalId>;
  /** Give the persona's principal its role (when it has one), then link its `sub` to it. */
  seat(persona: WorldPersona, principal: PrincipalId): Promise<void>;
  grantShape(input: { principal: PrincipalId; entity: EntityRef; permissions: readonly PermissionKey[]; grantedBy: PrincipalId }): Promise<void>;
  invoke<O, I>(persona: WorldPersona, principal: PrincipalId, operation: string, input?: I): Promise<O>;
}

export interface SeatWorldOptions {
  world: SeedWorld;
  /** `home` seats the personas of this scope; `elsewhere` the outsiders, in their own tenant. */
  seat?: 'home' | 'elsewhere';
  /** Run `world.build` over the personas seated here. Only for a fresh scope: a build is not idempotent, the seating is. */
  build?: boolean;
}

export interface SeatWorldInput extends SeatWorldOptions {
  actor: PlatformActorId;
  node: { tenantId: TenantId; scopeId: ScopeId };
  /** The identity pool the personas' `sub`s belong to. Registered by the caller. */
  provider: string;
}

/**
 * Seat a world's personas in one scope of `host`, through its admin directory, and build its
 * records when asked. Answers each seated persona by `sub`.
 */
export async function seatWorld(host: ScopeHost, input: SeatWorldInput): Promise<Map<string, WorldSeat>> {
  const { actor, node, provider } = input;
  return await seatWorldWith(
    {
      resolve: async (sub) => {
        const known = await host.admin.resolveIdentity(node.tenantId, provider, sub);
        if (known?.scopeId && known.scopeId !== node.scopeId) {
          throw new Error(`seed world: identity '${sub}' is linked to another scope`);
        }
        return known?.principal ?? null;
      },
      seat: async (persona, principal) => {
        if (persona.role) await host.admin.assignRole(actor, { principalId: principal, roleKey: persona.role, node });
        await host.admin.linkIdentity(actor, { provider, externalId: persona.sub, principal, tenantId: node.tenantId, scopeId: node.scopeId });
      },
      grantShape: async ({ principal, entity, permissions, grantedBy }) => {
        await host.admin.grantEntityShape(actor, { principalId: principal, node, entity, permissions, grantedBy });
      },
      invoke: async <O, I>(persona: WorldPersona, principal: PrincipalId, operation: string, payload?: I) => {
        const stub = await host.getScope(principal, node.tenantId, node.scopeId, { verifiedEmail: persona.email });
        return await stub.invoke<O, I>(operation, payload as I);
      },
    },
    input,
  );
}

/**
 * Seat a world's personas through `seating`, and build its records when asked: the one
 * procedure {@link seatWorld} and a deployed vertical's seeded preview share. A persona already
 * linked keeps its principal and is not seated again.
 */
export async function seatWorldWith(seating: WorldSeating, input: SeatWorldOptions): Promise<Map<string, WorldSeat>> {
  const { world } = input;
  const elsewhere = (input.seat ?? 'home') === 'elsewhere';
  const seats = new Map<string, WorldSeat>();
  const seated = world.personas.filter((p) => Boolean(p.elsewhere) === elsewhere);
  for (const persona of seated) {
    const known = await seating.resolve(persona.sub);
    const principal = known ?? (seating.principalFor ? await seating.principalFor(persona.sub) : principalId.parse(ulid()));
    if (!known) await seating.seat(persona, principal);
    seats.set(persona.sub, {
      principal,
      invoke: <O, I>(operation: string, payload?: I) => seating.invoke<O, I>(persona, principal, operation, payload),
    });
  }
  if (input.build && world.build) {
    const seatOf = (sub: string): WorldSeat => {
      const seat = seats.get(sub);
      if (!seat) throw new Error(`seed world: no persona '${sub}' is seated in this scope`);
      return seat;
    };
    await world.build({
      personas: seated,
      as: seatOf,
      grantShape: async ({ to, entity, permissions, grantedBy }) => {
        await seating.grantShape({ principal: seatOf(to).principal, entity, permissions, grantedBy: seatOf(grantedBy).principal });
      },
    });
  }
  return seats;
}

const CROCKFORD = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';

/**
 * The principal a persona is seated as in a deployed preview: derived from the scope and its
 * `sub`, so every push of the preview seats it as the same principal (see
 * {@link WorldSeating.principalFor}). Ulid-shaped, its first character kept to `0`–`7` as a
 * ulid's is. Web Crypto only.
 */
export async function personaPrincipal(scopeId: ScopeId, sub: string): Promise<PrincipalId> {
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(`persona:${scopeId}:${sub}`)));
  let id = CROCKFORD[digest[0]! % 8]!;
  for (let i = 1; i < 26; i++) id += CROCKFORD[digest[i]! % 32];
  return principalId.parse(id);
}
