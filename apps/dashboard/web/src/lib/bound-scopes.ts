/**
 * The shapes these functions read, stated structurally rather than imported from `./api`:
 * this file is compiled by the worker's test project too (`bound-scopes.test.ts` runs it
 * beside the worker's own guard), and `./api` is DOM-typed and would drag the browser's
 * whole client into a program that has no DOM. `Deployment` and `BoundScopesView` satisfy
 * these, and the generics hand back the caller's own type.
 */
interface DeploymentLike {
  slug: string;
  versions: ReadonlyArray<{ createdAt: string }>;
  channels: ReadonlyArray<{ channel: string }>;
}

/**
 * The small decisions behind a vertical's "Bound scopes" section (#1592), kept out of the
 * component so they are plain functions the worker's test suite can hold to account.
 *
 * `isRetireArmed` restates the rule `retireBoundScopes` enforces server-side
 * (`src/bound-scopes.ts`). The two bundles are separated by wire — the browser never
 * imports the worker — so the rule is written twice and `bound-scopes.test.ts` runs both
 * over the same cases. A button that arms on a rule the server does not hold is a button
 * that lies; the server refusing is the guard, this is what keeps the dialog honest about it.
 */

/** Whether what was typed arms retiring `count` scopes: the count itself, in digits. */
export function isRetireArmed(typed: string, count: number): boolean {
  return count > 0 && typed.trim() === String(count);
}

/**
 * Whether the vertical's page gets a "Bound scopes" section at all. Not while the read is
 * in flight (nothing to flash) and not when it came back empty: a heading over a list of
 * zero promises work that is not there.
 */
export function hasBoundScopes<V extends { scopes: readonly unknown[] }>(view: V | null): view is V {
  return view !== null && view.scopes.length > 0;
}

/** The newest push to a vertical, as an ISO instant — '' when it has none. */
function newestPush(d: DeploymentLike): string {
  return d.versions[0]?.createdAt ?? '';
}

/**
 * The verticals a Move can land on: the team's other verticals that have a `prod` version
 * to serve from (the plane refuses one that has not — "promote a version to prod first" —
 * so offering it is offering a certain refusal), newest push first. Newest first because
 * the usual reason there is anything to move is a rename, and the vertical the versions
 * now land under is the one pushed to most recently.
 */
export function moveTargets<D extends DeploymentLike>(current: D, all: readonly D[]): D[] {
  return all
    .filter((d) => d.slug !== current.slug && d.channels.some((c) => c.channel === 'prod'))
    .sort((a, b) => newestPush(b).localeCompare(newestPush(a)) || a.slug.localeCompare(b.slug));
}

/**
 * Whether the installs on `current` look stranded by a package rename (#399): the team
 * has another vertical that has been pushed to more recently than this one. A slug derived
 * from the package name follows a rename, so new versions land under the new slug while
 * the installs stay on the old — and "another vertical of mine got the latest push" is the
 * shape that leaves. Only a hint (it says "may have"), so a false positive costs one line.
 */
export function looksStrandedByRename(current: DeploymentLike, all: readonly DeploymentLike[]): boolean {
  const mine = newestPush(current);
  return all.some((d) => d.slug !== current.slug && newestPush(d) > mine);
}

/**
 * What a refused Remove tells the person, given the registry's own sentence and how many of
 * this team's installs the vertical's page lists. The plane counts EVERY team's installs and
 * the page lists only this team's, so the three cases say different things: none of ours (the
 * blockers are another team's), some of ours (clearing them may not be enough — the count can
 * include others), and unknown (the read failed, so promise nothing about the list).
 */
export function removalRefusalDetail(message: string, ours: number | null): string {
  if (ours === 0) return `${message}. None of them are your team’s — another team has this vertical installed.`;
  if (ours === null) return `${message}. Your team’s installs are listed under Bound scopes on this page.`;
  return `${message}. Your team’s are listed under Bound scopes on this page — move or retire them; the count can also include other teams’ installs, which only they can clear.`;
}
