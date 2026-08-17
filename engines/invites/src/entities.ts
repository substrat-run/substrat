import { defineEntities } from '@substrat-run/contracts';
import { z } from 'zod';

/**
 * engine-invites' entity (#697/#707).
 *
 * `identifier_hash` is stored and DELIBERATELY not published: `Invitation` omits
 * it, because the whole point of hashing the invitee's identifier is that the
 * engine can match it without anyone else reading it. So the registry describes
 * the ROW — what is stored, which is what the journal comparison checks — and
 * `invitation` is the published projection a vertical may return.
 *
 * Same row-versus-published split as engine-workorder, for a different reason:
 * there it was shape (two columns → one `EntityRef`), here it is privacy.
 */
export const invitesEntities = defineEntities({
  invitation: {
    table: 'invites_invitation',
    fields: z.object({
      id: z.string(),
      org_id: z.string(),
      /** Never published — see `invitation` below. */
      identifier_hash: z.string(),
      role_key: z.string(),
      state: z.string(),
      invited_by: z.string(),
      accepted_by: z.string().nullable(),
      created_at: z.string(),
      expires_at: z.string(),
      settled_at: z.string().nullable(),
    }),
    // The hash IS the erasure handle: destroying it is what unlinks an
    // invitation from the person it was sent to.
    erasable: ['identifier_hash'],
  },
});

/** The stored row, including the hash. */
export const invitationRow = invitesEntities.invitation.fields;

/**
 * What an operation may RETURN — the row minus the hash. A vertical declaring an
 * `output` wants this one; returning `invitationRow` would publish the very
 * thing the hashing exists to keep unreadable.
 */
export const invitation = invitesEntities.invitation.fields.omit({ identifier_hash: true });
