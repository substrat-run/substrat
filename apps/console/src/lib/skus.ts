/**
 * The console-maintained SKU list, offered by the grant dialog's `<select>`.
 *
 * The platform has NO entitlement-key catalogue — `operationEntitlement` is a private
 * in-memory map on the host, built from manifests at registration — so nothing here was
 * validated against what the platform will actually honour. The list is the console's own
 * guess, and granting a key no manifest declares silently does nothing useful.
 *
 * It is HAND-MAINTAINED, and it will go stale again until a real catalogue endpoint
 * exists (#689): every engine or vertical that declares an `entitlementKey` has to be
 * typed in here by a person. It already went stale once — `absence`, `booking`,
 * `invites` and `metering` all shipped as engines while the list still named five keys,
 * so an operator could not grant them from the UI at all and reached for a `curl`
 * instead. `test/skus.test.ts` is what catches the next one: it reads every engine's
 * declared key off disk and fails if this list has fallen behind.
 *
 * Order is deliberate. The seven engine keys come first as a group, in the order the
 * engines shipped, then the vertical/platform SKUs — and `workorder` stays first because
 * it is the dialog's default selection, and quietly moving that would change which key a
 * confirm-without-touching grants.
 */
export const KNOWN_SKUS = [
  // The seven engines (each declares `entitlementKey` in its own `src/index.ts`).
  'workorder',
  'invoicing',
  'protocol',
  'booking',
  'absence',
  'invites',
  'metering',
  // Vertical- and platform-level SKUs.
  'shop',
  'builder',
];
