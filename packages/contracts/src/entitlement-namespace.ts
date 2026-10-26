/**
 * Whose entitlement key is whose (#2388). A key is one flat word, so its meaning must not depend
 * on which vertical declared it first: a vertical with bare slug `S` (a workspace prefix,
 * `<tenant>/S`, is not part of the key) declares exactly `S`, plus the keys the platform
 * publishes for engines, plus the bare slug of each vertical it declares it `provisions` (a
 * tenant-provisioner manager sells the products it creates). A platform-granted key is never declarable, even by a vertical whose
 * slug happens to spell it.
 */

/**
 * The `entitlementKey` of each engine — the keys a vertical composing the engine may declare
 * beside its own. A list here because contracts cannot import the engines;
 * `test/entitlement-namespace.test.ts` reads every `engines/*` manifest, so a tenth engine reds
 * it until it is listed.
 */
export const ENGINE_ENTITLEMENT_KEYS: readonly string[] = [
  'workorder',
  'invoicing',
  'protocol',
  'booking',
  'absence',
  'invites',
  'metering',
  'notifications',
  'assistant',
];

/** Keys only staff or the platform grant: the dashboard's own SKU and the builder studio's. */
export const PLATFORM_ENTITLEMENT_KEYS: readonly string[] = ['dashboard', 'builder'];

const bareSlug = (slug: string): string => slug.split('/').pop() || slug;

/** Whether the vertical `slug` may declare `key`, and so whether an install may grant it from that declaration. */
export function declarableEntitlementKey(slug: string, key: string, provisions: readonly string[] = []): boolean {
  if (PLATFORM_ENTITLEMENT_KEYS.includes(key)) return false;
  return key === bareSlug(slug) || ENGINE_ENTITLEMENT_KEYS.includes(key) || provisions.some((p) => bareSlug(p) === key);
}

/** The keys of a registry row's declaration that an install or a grant may act on. */
export function grantableEntitlements(slug: string, declared: readonly string[], provisions: readonly string[] = []): string[] {
  return declared.filter((key) => declarableEntitlementKey(slug, key, provisions));
}

/**
 * The refusal for a push declaring a key its vertical may not, or `undefined`. A fixed sentence:
 * it echoes the key the pusher wrote and names the pusher's own vertical, nothing else.
 */
export function entitlementNamespaceRefusal(
  slug: string,
  keys: readonly string[],
  provisions: readonly string[] = [],
): string | undefined {
  const key = keys.find((k) => !declarableEntitlementKey(slug, k, provisions));
  if (key === undefined) return undefined;
  return (
    `entitlement '${key}' is not declarable by '${bareSlug(slug)}': a vertical declares its own key ` +
    `'${bareSlug(slug)}', the published engine keys and the keys of the verticals it provisions, and a platform-granted key is never declared`
  );
}
