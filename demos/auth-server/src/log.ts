/**
 * The issuer's console lines, each stamped with the version that wrote them.
 *
 * A hosted issuer is one script updated in place on every promote, so a line read in the
 * runtime's log view says nothing about which push produced it — and "did the fix ship yet"
 * is the question a log is most often opened to answer. The platform injects the id of the
 * version being served as `SUBSTRAT_VERSION_ID` (the id the console admits and promotes);
 * every line here carries it as `version`.
 *
 * Not package.json's version: a push takes its label from the registry, patch-bumping the
 * highest one there, so every merge to main is a new version while package.json moves only on
 * a release. Pairing a line with the package version would name the same number for weeks.
 *
 * Each line is one JSON object, so the runtime's log view indexes `version` as a field rather
 * than as text to grep for. A standalone or local issuer has no injected id and writes
 * `version: null`, which is the honest answer.
 *
 * The id is held at module scope because most writers here (a plugin, the Twilio guard) are
 * handed no env. That is sound for the same reason the binding is: an isolate runs one
 * version of one script, and both of its entry points — the worker and the issuer DO — call
 * `noteVersion` before anything they serve can log.
 */

let versionId: string | null = null;

/** Record the version this isolate is serving, read off the platform's binding. */
export function noteVersion(env: { SUBSTRAT_VERSION_ID?: string }): void {
  const v = env.SUBSTRAT_VERSION_ID;
  versionId = typeof v === 'string' && v.length > 0 ? v : null;
}

/** The version id this isolate is serving, or null where nothing injected one. */
export function servedVersion(): string | null {
  return versionId;
}

type Detail = Record<string, unknown>;

/** An `Error` serialises to `{}`; this keeps what a reader needs from one. */
function replacer(_key: string, value: unknown): unknown {
  return value instanceof Error ? { name: value.name, message: value.message, stack: value.stack } : value;
}

function line(message: string, detail?: Detail): string {
  // `app` and `version` last, so no detail key can overwrite them.
  return JSON.stringify({ message, ...detail, app: 'auth-server', version: versionId }, replacer);
}

export const log = {
  info: (message: string, detail?: Detail) => console.log(line(message, detail)),
  warn: (message: string, detail?: Detail) => console.warn(line(message, detail)),
  error: (message: string, detail?: Detail) => console.error(line(message, detail)),
};
