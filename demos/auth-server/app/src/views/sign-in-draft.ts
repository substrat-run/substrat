/** The slice of the issuer's public provider list this module needs — declared here, not
 *  imported from `api.ts`, so the draft rules stay a pure module a node test can load. */
type PublicProvider = { id: string; label: string };

/**
 * The sign-in form's state, and its two-way mapping to the stored `metadata.signIn` policy
 * (`src/sign-in-policy.ts`). Pure, so the rules about what the form may write sit in one
 * place a test can reach rather than in a component.
 */

export const PASSWORD_METHOD = 'password';
/** "Any provider" before the issuer's list has arrived — resolved to every offered id. */
export const ANY_PROVIDER = '*';

export interface RouteDraft {
  /** A stable React key; never stored. */
  key: string;
  /** What the operator typed: domains separated by spaces, commas or lines. */
  domains: string;
  provider: string;
}

export interface PolicyDraft {
  /** Off ⇒ no `signIn` key at all: every method the issuer offers, now and later. */
  restrict: boolean;
  /** `PASSWORD_METHOD` and provider ids open to EVERYONE. */
  methods: Set<string>;
  requireSms: boolean;
  identifierFirst: boolean;
  routes: RouteDraft[];
}

let nextKey = 0;
export const newRoute = (provider = ''): RouteDraft => ({ key: `route-${nextKey++}`, domains: '', provider });

export function draftFromStored(stored: unknown): PolicyDraft {
  const policy = stored && typeof stored === 'object' && !Array.isArray(stored) ? (stored as Record<string, unknown>) : null;
  const methods = new Set<string>(Array.isArray(policy?.providers) ? (policy.providers as string[]) : []);
  if (policy && !Array.isArray(policy.providers)) methods.add(ANY_PROVIDER);
  if (!policy || policy.password !== false) methods.add(PASSWORD_METHOD);
  const routes = Array.isArray(policy?.domainRoutes)
    ? (policy.domainRoutes as { domains?: unknown; provider?: unknown }[]).map((route) => ({
        ...newRoute(typeof route.provider === 'string' ? route.provider : ''),
        domains: Array.isArray(route.domains) ? route.domains.join(', ') : '',
      }))
    : [];
  return {
    restrict: policy !== null,
    methods,
    requireSms: policy?.passwordSecondFactor === 'sms',
    identifierFirst: policy?.identifierFirst === true,
    routes,
  };
}

/** Replace the `ANY_PROVIDER` placeholder with every provider the issuer offers. */
export function resolveAny(draft: PolicyDraft, offered: readonly PublicProvider[]): PolicyDraft {
  if (!draft.methods.has(ANY_PROVIDER)) return draft;
  const methods = new Set(draft.methods);
  methods.delete(ANY_PROVIDER);
  for (const provider of offered) methods.add(provider.id);
  return { ...draft, methods };
}

/** `"@Acme.se, acme.com\nfoo.org"` → `['acme.se', 'acme.com', 'foo.org']`. */
export function parseDomains(text: string): string[] {
  return [...new Set(text.split(/[\s,;]+/).map((d) => d.trim().replace(/^@/, '').toLowerCase()).filter(Boolean))];
}

const DOMAIN = /^(?=.{1,253}$)[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)+$/;

/** What is wrong with the form, in words for the person holding it. Empty ⇒ saveable. */
export function draftProblems(draft: PolicyDraft, offered: readonly PublicProvider[], builtin: boolean): string[] {
  if (!draft.restrict) return [];
  const problems: string[] = [];
  const seen = new Map<string, number>();
  draft.routes.forEach((route, index) => {
    const n = index + 1;
    const domains = parseDomains(route.domains);
    if (!domains.length) problems.push(`Rule ${n}: enter at least one email domain, such as acme.se.`);
    for (const domain of domains) {
      if (!DOMAIN.test(domain)) problems.push(`Rule ${n}: “${domain}” is not a domain name (write acme.se, not an address).`);
      else if (seen.has(domain)) problems.push(`Rule ${n}: ${domain} is already in rule ${seen.get(domain)} — an address can sign in one way only.`);
      else seen.set(domain, n);
    }
    if (!route.provider) problems.push(`Rule ${n}: choose the provider these addresses sign in with.`);
    else if (!offered.some((p) => p.id === route.provider)) problems.push(`Rule ${n}: ${route.provider} is not a provider this issuer offers.`);
  });
  if (!builtin && draft.routes.length && !draft.identifierFirst) {
    problems.push('Domain rules need “Ask for email first” — without it nobody types an address before choosing a method.');
  }
  return problems;
}

/** The `signIn` object to store, or `undefined` for "no restriction". */
export function draftToStored(
  draft: PolicyDraft,
  offered: readonly PublicProvider[],
  builtin: boolean,
): Record<string, unknown> | undefined {
  if (!draft.restrict) return undefined;
  const password = draft.methods.has(PASSWORD_METHOD);
  const routes = !builtin && draft.identifierFirst
    ? draft.routes.map((route) => ({ domains: parseDomains(route.domains), provider: route.provider }))
    : [];
  return {
    providers: offered.filter((p) => draft.methods.has(p.id)).map((p) => p.id),
    password,
    ...(draft.requireSms && !builtin && password ? { passwordSecondFactor: 'sms' } : {}),
    ...(!builtin && draft.identifierFirst ? { identifierFirst: true } : {}),
    ...(routes.length ? { domainRoutes: routes } : {}),
  };
}

export interface FlowPreview {
  /** What the first screen offers everyone. */
  first: string[];
  /** One line per kind of visitor, in the order they are decided. */
  visitors: { who: string; what: string }[];
  /** True when nobody can get in — the one preview that is a warning. */
  deadEnd: boolean;
}

/** "What people will see", derived from the same draft the form writes — so the summary under
 *  the form cannot drift from what saving does. */
export function describeFlow(draft: PolicyDraft, offered: readonly PublicProvider[], builtin: boolean): FlowPreview {
  const label = (id: string) => offered.find((p) => p.id === id)?.label ?? id;
  const open = offered.filter((p) => draft.methods.has(p.id));
  const password = draft.methods.has(PASSWORD_METHOD);
  const sms = draft.requireSms && !builtin && password;
  const passwordWhat = sms ? 'password, then an SMS code (they register their phone the first time)' : 'password';
  if (!draft.restrict) return { first: ['Every method this issuer offers'], visitors: [], deadEnd: false };
  const visitors: FlowPreview['visitors'] = [];
  if (!builtin && draft.identifierFirst) {
    for (const route of draft.routes) {
      const domains = parseDomains(route.domains).map((d) => `@${d}`).join(', ');
      if (domains && route.provider) visitors.push({ who: `Email ${domains}`, what: `${label(route.provider)} only` });
    }
    visitors.push({ who: draft.routes.length ? 'Any other email' : 'Email', what: password ? passwordWhat : 'not accepted' });
    for (const provider of open) visitors.push({ who: `Chooses ${provider.label}`, what: `${provider.label}` });
    const first = [...open.map((p) => p.label), 'Email address'];
    return { first, visitors, deadEnd: !password && !open.length && !draft.routes.length };
  }
  const first = [...open.map((p) => p.label), ...(password ? ['Email and password'] : [])];
  if (password) visitors.push({ who: 'Email and password', what: passwordWhat });
  for (const provider of open) visitors.push({ who: provider.label, what: provider.label });
  return { first, visitors, deadEnd: !first.length };
}
