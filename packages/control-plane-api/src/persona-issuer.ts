import type { ScopeId, TenantId } from '@substrat-run/contracts';

/**
 * The control plane's persona issuer, as preview create reaches it (#3108). The issuer itself —
 * its signing key, the picker, the token endpoint — is the hosted control plane's
 * (`apps/control-plane/src/persona-issuer.ts`); this is only what a create needs from it: the
 * sign-in client a seeded preview's login is delivered with.
 */
export interface PersonaIssuerSeam {
  /**
   * The preview's client: its issuer, id and secret. Registers the preview's tenant and callback
   * with the issuer, idempotently, and answers the same secret every time it is asked for one
   * preview, so every push delivers a secret that still works.
   */
  client(input: { tenantId: TenantId; previewScopeId: ScopeId; redirectUri: string }): Promise<{
    issuer: string;
    clientId: string;
    clientSecret: string;
  }>;
}
