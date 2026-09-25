import { z } from '@substrat-run/contracts';
import { issuerRefusal } from '@substrat-run/oidc-rp/discovery';

/** An Identity choice as the API accepts it — install form and Settings tab alike. */
export const appAuthChoiceBody = z.discriminatedUnion('source', [
  z.object({ source: z.literal('auth-server'), scopeId: z.string().min(1) }),
  z.object({
    source: z.literal('external'),
    // The same predicate discovery applies (`issuerRefusal`): https or loopback, and a plain
    // identifier. A value discovery would refuse on every login is not a configuration that
    // can be saved.
    issuer: z.string().url().refine((i) => issuerRefusal(i) === null, 'an issuer must be https, with no query, fragment or credentials'),
    clientId: z.string().min(1),
    clientSecret: z.string().optional(),
    audience: z.string().optional(),
  }),
]);
