/** Types for `workerd-as-uploaded.mjs` — a vertical's workerd config, as the platform uploads it (#1902). */
export function asUploaded(
  dir: string,
  derived: Record<string, unknown>,
): Promise<Record<string, unknown> & { vars: Record<string, string> }>;

/** What a push of `dir` declares about its sweeper — memoized per directory. */
export function declaredSweeper(
  dir: string,
  cfg: Record<string, unknown>,
): Promise<{
  /** The manifest's `schedules`, as `deriveDeclaredSurface` flattens them. */
  schedules: readonly unknown[] | undefined;
  sweeperClasses: string[] | undefined;
}>;

/** A store script as the platform uploads it (#2289): the entry in front of the kind. */
export function storeScriptAsUploaded(
  dir: string,
  options: {
    kindMain: string;
    className: string;
    script: string;
    callerPublicKeys: string[];
    platformPublicKeys: string[];
  },
): Promise<{
  main: string;
  modules: string[];
  className: string;
  binding: string;
  /** The plain-text bindings the upload carries, by name. */
  text: Record<string, string>;
}>;
