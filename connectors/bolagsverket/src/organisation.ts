import { z } from 'zod';
import type { BolagsverketEnvironment } from './config.js';

/**
 * The provider's organisation record, and the normalised result a caller gets.
 *
 * **The provider shape is not recorded.** No credential exists yet, so `rawOrganisation`
 * follows what community client libraries read from `POST /organisationer`; the live
 * suite is what confirms it. That is why the parse is lenient everywhere it can be: every
 * block is optional and nullable, extra fields are ignored, and only the identity number
 * is required. A field the provider renames reads as `null` in the result rather than
 * failing the lookup, and the live suite's log shows which.
 */

const nullable = <T extends z.ZodTypeAny>(schema: T) =>
  z
    .union([schema, z.null()])
    .optional()
    .transform((v) => v ?? null);

/** Bolagsverket's and SCB's code/plain-text pair (`kod` / `klartext`). */
const codeText = z.object({ kod: nullable(z.string()), klartext: nullable(z.string()) });
type CodeText = z.infer<typeof codeText>;

export const rawOrganisation = z.object({
  organisationsidentitet: z.object({ identitetsbeteckning: z.string() }),
  organisationsnamn: nullable(
    z.object({
      organisationsnamnLista: nullable(
        z.array(z.object({ namn: nullable(z.string()), organisationsnamntyp: nullable(codeText) })),
      ),
    }),
  ),
  juridiskForm: nullable(codeText),
  organisationsform: nullable(codeText),
  organisationsdatum: nullable(z.object({ registreringsdatum: nullable(z.string()) })),
  avregistreradOrganisation: nullable(z.object({ avregistreringsdatum: nullable(z.string()) })),
  avregistreringsorsak: nullable(codeText),
  pagandeAvvecklingsEllerOmstruktureringsforfarande: nullable(
    z.object({
      pagandeAvvecklingsEllerOmstruktureringsforfarandeLista: nullable(z.array(codeText)),
    }),
  ),
  naringsgrenOrganisation: nullable(z.object({ sni: nullable(z.array(codeText)) })),
  postadressOrganisation: nullable(
    z.object({
      postadress: nullable(
        z.object({
          utdelningsadress: nullable(z.string()),
          postnummer: nullable(z.string()),
          postort: nullable(z.string()),
          land: nullable(z.string()),
        }),
      ),
    }),
  ),
});
export type RawOrganisation = z.infer<typeof rawOrganisation>;

export const rawOrganisationResponse = z.object({ organisationer: nullable(z.array(rawOrganisation)) });

/**
 * Where a register entry stands. `deregistered` wins over an ongoing procedure, since a
 * deregistered entity has nothing left in progress; `other` is a procedure this version
 * does not name, passed through with its text in `statusDetail` rather than guessed at.
 */
export const ORGANISATION_STATUSES = [
  'active',
  'deregistered',
  'liquidation',
  'bankruptcy',
  'reorganisation',
  'other',
] as const;
export type OrganisationStatus = (typeof ORGANISATION_STATUSES)[number];

const codeLabel = z.object({ code: z.string(), label: z.string().nullable() });

const source = z.object({
  provider: z.literal('bolagsverket'),
  environment: z.enum(['prod', 'test']),
});

/** The answer to "is this a registered organisation", with when it was asked. */
export const organisationValidation = z.discriminatedUnion('exists', [
  z.object({
    exists: z.literal(true),
    orgnr: z.string(),
    name: z.string().nullable(),
    legalForm: codeLabel.nullable(),
    status: z.enum(ORGANISATION_STATUSES),
    statusDetail: z.string().nullable(),
    address: z
      .object({
        street: z.string().nullable(),
        postalCode: z.string().nullable(),
        city: z.string().nullable(),
        country: z.string().nullable(),
      })
      .nullable(),
    sni: z.array(codeLabel),
    registeredAt: z.string().nullable(),
    source,
    fetchedAt: z.string(),
  }),
  z.object({ exists: z.literal(false), orgnr: z.string(), source, fetchedAt: z.string() }),
]);
export type OrganisationValidation = z.infer<typeof organisationValidation>;

function asCodeLabel(v: CodeText | null): { code: string; label: string | null } | null {
  return v?.kod ? { code: v.kod, label: v.klartext } : null;
}

/**
 * A procedure's status, read from its plain text. The codes behind the text are not
 * documented anywhere this connector can cite yet, so matching on the words the register
 * prints is the reading least likely to be wrong; the live suite can tighten it to codes.
 */
function procedureStatus(p: CodeText): OrganisationStatus {
  const text = `${p.kod ?? ''} ${p.klartext ?? ''}`.toLowerCase();
  if (text.includes('konkurs')) return 'bankruptcy';
  if (text.includes('likvidation')) return 'liquidation';
  if (text.includes('rekonstruktion')) return 'reorganisation';
  return 'other';
}

export function organisationResult(
  raw: RawOrganisation,
  orgnr: string,
  environment: BolagsverketEnvironment,
  fetchedAt: string,
): OrganisationValidation {
  const names = raw.organisationsnamn?.organisationsnamnLista ?? [];
  const name =
    names.find((n) => n.organisationsnamntyp?.kod === 'FORETAGSNAMN')?.namn ?? names.find((n) => n.namn)?.namn ?? null;

  const procedure = raw.pagandeAvvecklingsEllerOmstruktureringsforfarande
    ?.pagandeAvvecklingsEllerOmstruktureringsforfarandeLista?.[0];
  const [status, statusDetail]: [OrganisationStatus, string | null] = raw.avregistreradOrganisation
    ? ['deregistered', raw.avregistreringsorsak?.klartext ?? null]
    : procedure
      ? [procedureStatus(procedure), procedure.klartext]
      : ['active', null];

  const post = raw.postadressOrganisation?.postadress;
  return {
    exists: true,
    orgnr,
    name,
    legalForm: asCodeLabel(raw.juridiskForm) ?? asCodeLabel(raw.organisationsform),
    status,
    statusDetail,
    address: post
      ? { street: post.utdelningsadress, postalCode: post.postnummer, city: post.postort, country: post.land }
      : null,
    // An entry without a code says nothing a caller can use, so it is dropped.
    sni: (raw.naringsgrenOrganisation?.sni ?? []).flatMap((s) => asCodeLabel(s) ?? []),
    registeredAt: raw.organisationsdatum?.registreringsdatum ?? null,
    source: { provider: 'bolagsverket', environment },
    fetchedAt,
  };
}
