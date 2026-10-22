import { recordAuthCheck, type AuthCheck } from '@substrat-run/contracts/auth-diagnostics';

/** Read jose's stable codes structurally: bundled copies need not share constructors. */
export function verificationReason(error: unknown): AuthCheck['reason'] | undefined {
  if (!error || typeof error !== 'object') return undefined;
  const { code, claim } = error as { code?: unknown; claim?: unknown };
  switch (code) {
    case 'ERR_JWT_EXPIRED': return 'token-expired';
    case 'ERR_JWT_CLAIM_VALIDATION_FAILED':
      switch (claim) {
        case 'iss': return 'issuer-invalid';
        case 'aud': return 'audience-invalid';
        case 'nbf': return 'token-not-active';
        default: return 'claims-invalid';
      }
    case 'ERR_JWS_SIGNATURE_VERIFICATION_FAILED': return 'signature-invalid';
    case 'ERR_JWS_INVALID':
    case 'ERR_JWT_INVALID':
    case 'ERR_JOSE_ALG_NOT_ALLOWED':
    case 'ERR_JOSE_NOT_SUPPORTED': return 'token-invalid';
    default: return undefined;
  }
}

export function bearerRefused(reason: AuthCheck['reason'], outcome: 'refused' | 'error' = 'refused'): null {
  recordAuthCheck({ stage: 'bearer', outcome, reason });
  return null;
}
