/**
 * The Workers-for-Platforms dispatch namespace the REST-side calls address (#962).
 *
 * The `DISPATCH` binding is per-environment in wrangler.jsonc (`substrat-verticals`
 * for prod, `substrat-verticals-test` for TEST) — but the four REST-side WfP calls
 * (upload, modules fetch, bindings patch, the console's runtime links) address the
 * namespace by NAME through the Cloudflare API, and that name used to default to the
 * prod literal whenever `DISPATCH_NAMESPACE` was unset. TEST set no such var, so a
 * `substrat push` against the test control plane uploaded into prod's namespace while
 * the test `DISPATCH` binding served from the test one: the two halves of one deploy
 * disagreed about where the script lived.
 *
 * So there is no default. The name is a checked-in `vars` entry in BOTH environments,
 * and an unset value throws rather than silently choosing prod — the same stance as
 * `SCRIVE_BASE_URL` in wrangler.jsonc: an absent var is "silently pointed at the wrong
 * place", never "unconfigured".
 */
export function dispatchNamespaceOf(env: { DISPATCH_NAMESPACE?: string }): string {
  const namespace = env.DISPATCH_NAMESPACE?.trim();
  if (!namespace) {
    throw new Error(
      'DISPATCH_NAMESPACE is unset: the WfP dispatch namespace has no default (a wrong ' +
        'guess deploys into another environment). Set it in wrangler.jsonc `vars` for this ' +
        'environment, matching its `dispatch_namespaces` binding.',
    );
  }
  return namespace;
}
