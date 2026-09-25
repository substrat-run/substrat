import { z } from '@substrat-run/contracts';
import { isHttpsOrLoopbackUrl } from '@substrat-run/oidc-rp/discovery';

/** An Identity choice as the API accepts it — install form and Settings tab alike. */
export const appAuthChoiceBody = z.discriminatedUnion('source', [
  z.object({ source: z.literal('auth-server'), scopeId: z.string().min(1) }),
  z.object({
    source: z.literal('external'),
    // https (or loopback, for a dev issuer): the login sends the client secret to this issuer's
    // token endpoint, so a plaintext one is not a configuration that can be saved.
    issuer: z.string().url().refine(isHttpsOrLoopbackUrl, 'an issuer must be https'),
    clientId: z.string().min(1),
    clientSecret: z.string().optional(),
    audience: z.string().optional(),
  }),
]);
