/** Only a known empty declaration and a successful empty peer read have nothing to disclose. */
export function showPeerDisclosure(view: {
  declares: readonly string[] | null;
  calls: readonly unknown[];
  callers: readonly unknown[] | null;
  callersError: string | null;
}): boolean {
  return view.declares === null || view.declares.length > 0 || view.calls.length > 0 ||
    (view.callers?.length ?? 0) > 0 || view.callersError !== null;
}
