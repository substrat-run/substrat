/**
 * Whose entitlement key is whose (#2388). A key is one flat word, so its meaning must not depend
 * on which vertical declared it first: a vertical with bare slug `S` (a workspace prefix,
 * `<tenant>/S`, is not part of the key) declares exactly `S`, plus the keys the platform
 * publishes for engines. A tenant-provisioner manager sells plan features of the products it
 * creates, so it may also declare any other SKU that is not the bare slug of a different
 * registered vertical. A platform-granted key is never declarable, even by a vertical whose
 * slug happens to spell it.
 *
 * `otherVerticalSlugs` is the bare slug of every registered vertical; passing it marks the
 * declarer as a manager, leaving it out is a plain vertical.
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

/** The key-legal tail of a possibly workspace-prefixed registry slug (`<tenant>/name` → `name`). */
export const bareSlug = (slug: string): string => slug.split('/').pop() || slug;

/** Whether the vertical `slug` may declare `key`, and so whether an install may grant it from that declaration. */
export function declarableEntitlementKey(slug: string, key: string, otherVerticalSlugs?: readonly string[]): boolean {
  if (PLATFORM_ENTITLEMENT_KEYS.includes(key)) return false;
  if (key === bareSlug(slug) || ENGINE_ENTITLEMENT_KEYS.includes(key)) return true;
  return otherVerticalSlugs !== undefined && !otherVerticalSlugs.includes(key);
}

/** The keys of a registry row's declaration that an install or a grant may act on. */
export function grantableEntitlements(slug: string, declared: readonly string[], otherVerticalSlugs?: readonly string[]): string[] {
  return declared.filter((key) => declarableEntitlementKey(slug, key, otherVerticalSlugs));
}

/**
 * The refusal for a push declaring a key its vertical may not, or `undefined`. A fixed sentence:
 * it echoes the key the pusher wrote and names the pusher's own vertical, nothing else.
 */
export function entitlementNamespaceRefusal(
  slug: string,
  keys: readonly string[],
  otherVerticalSlugs?: readonly string[],
): string | undefined {
  const key = keys.find((k) => !declarableEntitlementKey(slug, k, otherVerticalSlugs));
  if (key === undefined) return undefined;
  return (
    `entitlement '${key}' is not declarable by '${bareSlug(slug)}': a vertical declares its own key ` +
    `'${bareSlug(slug)}' and the published engine keys, a tenant-provisioner also any SKU that is not another vertical's slug, ` +
    `and a platform-granted key is never declared`
  );
}
