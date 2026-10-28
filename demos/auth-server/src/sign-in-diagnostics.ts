import type { OAuthProvider } from 'better-auth';
import { callbackProviderOf, correlationOfState, DESCRIPTION_MAX, type SignInLogger } from './sign-in-log.js';

const callbackDiagnostics = new WeakMap<Request, CallbackDiagnostic>();

/** Request-local facts only: never retain a token, profile, email, or exception message. */
class CallbackDiagnostic {
  recorded = false;
  stage = 'Callback received; token exchange not reached';
  emailCheck: string | undefined;

  describe(): string {
    return [this.stage, this.emailCheck].filter(Boolean).join('. ');
  }
}

interface DiagnosticContext {
  socialProviders: OAuthProvider[];
  signInDiagnostic?: CallbackDiagnostic;
}

/**
 * Decorate copies, never the shared provider instances. Better Auth reuses its context across
 * requests, so mutating a provider itself would mix concurrent attempts. A class instance keeps
 * the mutable facts together through Better Auth's context merges, which copy plain objects.
 */
export function diagnoseSignInCallback(context: DiagnosticContext, method: string, request?: Request): void {
  const diagnostic = new CallbackDiagnostic();
  const isGithub = method === 'github';
  context.signInDiagnostic = diagnostic;
  if (request) callbackDiagnostics.set(request, diagnostic);
  context.socialProviders = context.socialProviders.map((provider) => {
    if (provider.id !== method) return provider;
    return {
      ...provider,
      async validateAuthorizationCode(input) {
        diagnostic.stage = 'Token exchange threw an exception';
        const tokens = await provider.validateAuthorizationCode(input);
        diagnostic.stage = tokens ? 'Token exchange succeeded; profile lookup not reached' : 'Token exchange returned no tokens';
        return tokens;
      },
      async getUserInfo(tokens) {
        diagnostic.stage = 'Token exchange succeeded; profile lookup threw an exception';
        const result = await provider.getUserInfo(tokens);
        diagnostic.stage = !result?.user
          ? 'Token exchange succeeded; provider returned no profile'
          : `Token exchange succeeded; profile received; email ${result.user.email ? 'present' : 'absent'}; email verified ${result.user.emailVerified === true ? 'yes' : 'no'}`;
        // Better Auth's GitHub adapter discards the email endpoint's error. Inspect it only
        // when the profile has no email, without changing the result or retrying the sign-in.
        if (isGithub && result?.user && !result.user.email && tokens.accessToken) {
          diagnostic.emailCheck = await githubEmailDiagnostic(tokens.accessToken);
        }
        return result;
      },
    };
  });
}

/** Unexpected exceptions bypass Better Auth's after-hooks. Record safe facts, then rethrow. */
export async function recordSignInException(request: Request, record?: SignInLogger): Promise<void> {
  if (!record) return;
  try {
    const diagnostic = callbackDiagnostics.get(request);
    if (diagnostic?.recorded) return;
    const url = new URL(request.url);
    const method = callbackProviderOf(url.pathname.replace(/^\/api\/auth/, ''));
    if (!method) return;
    record({
      method, phase: 'callback', outcome: 'failed', error: 'callback_exception',
      errorDescription: diagnostic?.describe().slice(0, DESCRIPTION_MAX) ?? 'Callback threw an exception before diagnostic information was available',
      correlation: await correlationOfState(url.searchParams.get('state')),
    });
  } catch {
    // A failed recorder must never replace the original error.
  }
}

/** The existing admin-only Detail field, bounded as before. Upstream descriptions win. */
export function signInDiagnosticDescription(context: DiagnosticContext, description: string | null): string | null {
  if (context.signInDiagnostic) context.signInDiagnostic.recorded = true;
  if (description) return description;
  const detail = context.signInDiagnostic?.describe();
  return [description, detail].filter(Boolean).join('. ').slice(0, DESCRIPTION_MAX) || null;
}

/**
 * This is a SECOND read after the adapter returned no email, not a trace of its first read.
 * A fixed URL, no redirects, and a short deadline bound this diagnostic's cost. Only status,
 * permission presence and counts survive; bodies and arbitrary headers never enter the log.
 */
async function githubEmailDiagnostic(accessToken: string): Promise<string> {
  try {
    const response = await fetch('https://api.github.com/user/emails', {
      headers: {
        authorization: `Bearer ${accessToken}`,
        accept: 'application/vnd.github+json',
        'user-agent': 'substrat-auth-diagnostics',
      },
      redirect: 'error',
      signal: AbortSignal.timeout(1500),
    });
    const prefix = `GitHub email check after missing profile email: HTTP ${response.status}`;
    if (!response.ok) {
      await response.body?.cancel();
      if (response.status === 403) {
        return `${prefix}; check OAuth App user:email scope or GitHub App Email addresses: read permission and re-authorize`;
      }
      if (response.status === 401) return `${prefix}; GitHub rejected the access token`;
      return `${prefix}; email endpoint unavailable`;
    }
    const emails: unknown = await response.json();
    if (!Array.isArray(emails)) return `${prefix}; unexpected response shape`;
    let primary = 0;
    let verified = 0;
    for (const email of emails) {
      if (!email || typeof email !== 'object') continue;
      if (email.primary === true) primary++;
      if (email.verified === true) verified++;
    }
    const granted = response.headers.get('x-oauth-scopes');
    const emailScope = granted === null ? 'not reported' : granted.split(',').some((s) => ['user', 'user:email'].includes(s.trim())) ? 'yes' : 'no';
    return `${prefix}; addresses=${emails.length}, primary=${primary}, verified=${verified}; OAuth email scope=${emailScope}`;
  } catch {
    // Fetch/parse errors can embed URLs, headers or bodies. Never persist their message.
    return 'GitHub email check after missing profile email: unavailable (network, timeout or unreadable response)';
  }
}
