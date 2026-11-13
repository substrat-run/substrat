import { z } from 'zod';

/**
 * PEOPLE shared between two apps of one tenant: the person contract.
 *
 * One app of a tenant owns the people (the MASTER): who exists, whether they are let in, and
 * which base roles they hold. Another app (a DEPENDENT, a plugin of the first) signs people in
 * at the same issuer and has no invitations of its own. When someone it has not seen signs in,
 * it asks the master who they are, by a peer call, and keeps the answer for a bounded time.
 *
 * This module is that question and its answer. The master implements one operation taking
 * {@link personResolveInput} and returning {@link personResolveOutput}, and allowlists the
 * dependent as a peer for it; `@substrat-run/vertical-auth/people` is the dependent's half.
 *
 * The answer is the AUTHORISATION half of a person and nothing else: an id, a status and role
 * keys. It carries no name and no address, so the copy a dependent keeps holds nothing an
 * erasure has to reach.
 */
export const IDENTITY_PERSON_CONTRACT = 'identity.person@1';

/**
 * Who is signing in at the dependent. `sub` and `issuer` are the login; `verifiedEmail` is the
 * address the issuer verified for it, or null. A master matches on whichever it records: one
 * that keeps each person's logins matches on (`issuer`, `sub`), and one that records the
 * verified address a person joined with matches on that, the proof a member invite is admitted
 * on (K-61). The address is the caller's own, sent to the app that already holds it.
 */
export const personResolveInput = z.object({
  issuer: z.string().min(1).nullable(),
  sub: z.string().min(1),
  verifiedEmail: z.string().min(1).nullable(),
});
export type PersonResolveInput = z.infer<typeof personResolveInput>;

/**
 * Whether the master lets the person in. Only `active` is admitted by a dependent; `invited`
 * has not arrived at the master yet, and `blocked` is refused everywhere.
 */
export const personStatus = z.enum(['invited', 'active', 'blocked']);
export type PersonStatus = z.infer<typeof personStatus>;

/**
 * The person as the master knows them, or null for a login it has nobody for. `id` is the
 * master's id for the person and becomes their principal in the dependent's scope. `roles` are
 * the MASTER's role keys, for the dependent to map onto its own; an empty list is a person
 * who is known and holds nothing there.
 */
export const personResolveOutput = z.object({
  person: z
    .object({
      id: z.string().min(1),
      status: personStatus,
      roles: z.array(z.string().min(1)),
    })
    .nullable(),
});
export type PersonResolveOutput = z.infer<typeof personResolveOutput>;
