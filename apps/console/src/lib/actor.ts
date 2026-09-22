import type { Actor } from '@substrat-run/contracts';

/**
 * How the console names an actor (#867, #1672) — a principal ULID, a `{ system }` module,
 * a `{ connection }`, or a `{ capability }`: whoever held a link. Lifted out of the denial
 * log so it can be tested: the log is the one place a refusal against a non-person reads
 * differently from one against a person, and a union member this missed used to fall
 * through to the connection branch and render `undefined`.
 */
export type ActorKind = 'principal' | 'system' | 'connection' | 'capability';

export function actorKind(a: Actor): ActorKind {
  if (typeof a === 'string') return 'principal';
  if ('system' in a) return 'system';
  if ('capability' in a) return 'capability';
  return 'connection';
}

export function actorLabel(a: Actor): string {
  if (typeof a === 'string') return a;
  if ('system' in a) return a.system;
  if ('capability' in a) return a.capability;
  return a.connection;
}

/** The filter value the API takes — the logical actor, not its stored JSON encoding. */
export function actorFilter(a: Actor): string {
  return typeof a === 'string' ? a : JSON.stringify(a);
}
