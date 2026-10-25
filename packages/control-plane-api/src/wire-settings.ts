/**
 * The fleet walk's one write (RFC wire-signing follow-on 4): bring a deployed script's four
 * `SUBSTRAT_WIRE_*` settings to what the control plane gives now, through the namespace's
 * script-settings endpoint, without uploading the script again.
 *
 * Only those four are ever changed. Every other binding goes back exactly as it was read, and a
 * secret is never read back at all: the endpoint answers a secret's name and type without its value,
 * so secrets ride `keep_bindings`, as the store patcher's do (`createWfpBindingsPatcher`). Nothing
 * here logs, stores or echoes a binding's value; a failure names the script, the status, and binding
 * NAMES only.
 *
 * It writes nothing when the four already match. Otherwise it re-reads before it writes (retrying at
 * most `CONCURRENT_RETRIES` times, then `concurrent-change`) and verifies after (`verify`, by name);
 * a serving script must run the version the directory serves (`serve-in-flight`).
 *
 * A script's bindings are also written by its uploads and by a store attached to one of its scopes.
 * The walk is not run while a push or promote of the same vertical is in flight, and every walk ends
 * with a confirming pass, which is mandatory.
 */
import { WIRE_AUDIENCE_VAR, WIRE_PLATFORM_KEYS_VAR, WIRE_ROUTER_KEYS_VAR, WIRE_STATE_VAR } from '@substrat-run/contracts/wire-signing';

/** The four settings the walk owns, and no other. */
const WIRE_SETTING_NAMES: readonly string[] = Object.freeze([WIRE_ROUTER_KEYS_VAR, WIRE_PLATFORM_KEYS_VAR, WIRE_AUDIENCE_VAR, WIRE_STATE_VAR]);
const OWNED = new Set(WIRE_SETTING_NAMES);

/** Binding types whose values the endpoint never returns: carried by `keep_bindings`, never sent. */
export const SECRET_BINDING_TYPES: readonly string[] = Object.freeze(['secret_text', 'secret_key']);
const SECRET = new Set(SECRET_BINDING_TYPES);

/** The version a script runs, as its upload injected it (#1242). */
export const VERSION_ID_VAR = 'SUBSTRAT_VERSION_ID';

/** How many times a change between the two reads is retried from the newer read. */
export const CONCURRENT_RETRIES = 3;

/** One binding as the settings endpoint answers it. */
export interface ScriptBinding {
  readonly type: string;
  readonly name: string;
  readonly [field: string]: unknown;
}

/** The namespace's script-settings endpoint: read a script's bindings, write them back. */
export interface WireSettingsApi {
  read(script: string): Promise<readonly ScriptBinding[]>;
  write(script: string, body: { readonly bindings: readonly ScriptBinding[]; readonly keep_bindings: readonly string[] }): Promise<void>;
}

/** What a desired state is: the four settings with their text, or none of them (withdrawn). */
export type WireSettingsWanted = readonly { readonly name: string; readonly text: string }[];

export type WireSettingsOutcome =
  /** The four already match: nothing was written. */
  | { readonly outcome: 'unchanged' }
  /** A dry run: what would change, by name. Nothing was written. */
  | { readonly outcome: 'would-change'; readonly changes: readonly string[] }
  /** Written and verified. */
  | { readonly outcome: 'updated'; readonly changes: readonly string[] }
  /** The bindings kept changing between the two reads: nothing was written. */
  | { readonly outcome: 'concurrent-change' }
  /** A serving script whose version is not the one served: nothing was written, or the serve moved after it was. */
  | { readonly outcome: 'serve-in-flight'; readonly written: boolean }
  /** Written, but the read after it differs, in these binding names. */
  | { readonly outcome: 'verify'; readonly bindings: readonly string[] };

/** A binding's identity: its type and name. Two bindings of one name and different types are two. */
const keyOf = (b: ScriptBinding) => `${b.type}:${b.name}`;

/** The plain-text value of one of the four, or `undefined` when the script does not carry it as plain text. */
function plainText(bindings: readonly ScriptBinding[], name: string): string | undefined {
  const b = bindings.find((x) => x.name === name);
  return b && b.type === 'plain_text' && typeof b['text'] === 'string' ? (b['text'] as string) : undefined;
}

/** The names among the four whose value (or presence, or type) differs from what is wanted. */
export function wireSettingsChanges(bindings: readonly ScriptBinding[], wanted: WireSettingsWanted): string[] {
  const want = new Map(wanted.map((w) => [w.name, w.text]));
  const changes: string[] = [];
  for (const name of WIRE_SETTING_NAMES) {
    const present = bindings.filter((b) => b.name === name);
    const text = want.get(name);
    if (text === undefined ? present.length > 0 : present.length !== 1 || plainText(bindings, name) !== text) changes.push(name);
  }
  return changes;
}

/**
 * A comparable form of what was read: every binding by identity, a non-secret one with all its
 * fields, a secret one by name and type alone (its value is never in the answer, and never used).
 */
function snapshot(bindings: readonly ScriptBinding[]): Map<string, string> {
  const out = new Map<string, string>();
  for (const b of bindings) {
    out.set(keyOf(b), SECRET.has(b.type) ? '' : JSON.stringify(Object.keys(b).sort().map((k) => [k, b[k]])));
  }
  return out;
}

const sameSnapshot = (a: Map<string, string>, b: Map<string, string>) => a.size === b.size && [...a].every(([k, v]) => b.get(k) === v);

/** The binding names whose snapshot differs between two reads, a name once. */
function differingNames(before: Map<string, string>, after: Map<string, string>): string[] {
  const names = new Set<string>();
  for (const [k, v] of before) if (after.get(k) !== v) names.add(k.slice(k.indexOf(':') + 1));
  for (const k of after.keys()) if (!before.has(k)) names.add(k.slice(k.indexOf(':') + 1));
  return [...names].sort();
}

/** The write body: every non-secret binding as read but the four, then the four as wanted. */
function bodyOf(bindings: readonly ScriptBinding[], wanted: WireSettingsWanted) {
  return {
    bindings: [
      ...bindings.filter((b) => !SECRET.has(b.type) && !OWNED.has(b.name)),
      ...wanted.map((w) => ({ type: 'plain_text', name: w.name, text: w.text })),
    ],
    keep_bindings: SECRET_BINDING_TYPES,
  };
}

/**
 * Bring `script`'s four settings to `wanted` (all four, or none to withdraw them). With `apply`
 * false it only reads: the write is unreachable. With `servedVersion`, the script is a serving
 * script and that is the version the directory says it serves; `servedVersionAfter` reads the
 * directory again after the write.
 */
export async function applyWireSettings(
  api: WireSettingsApi,
  script: string,
  wanted: WireSettingsWanted,
  opts: { readonly apply: boolean; readonly servedVersion?: string; readonly servedVersionAfter?: () => Promise<string | null> },
): Promise<WireSettingsOutcome> {
  const servesOther = (bindings: readonly ScriptBinding[]) =>
    opts.servedVersion !== undefined && plainText(bindings, VERSION_ID_VAR) !== opts.servedVersion;
  let current = await api.read(script);
  if (servesOther(current)) return { outcome: 'serve-in-flight', written: false };
  let changes = wireSettingsChanges(current, wanted);
  if (changes.length === 0) return { outcome: 'unchanged' };
  if (!opts.apply) return { outcome: 'would-change', changes };

  for (let attempt = 1; ; attempt++) {
    const again = await api.read(script);
    if (sameSnapshot(snapshot(current), snapshot(again))) break;
    if (attempt >= CONCURRENT_RETRIES) return { outcome: 'concurrent-change' };
    current = again;
    if (servesOther(current)) return { outcome: 'serve-in-flight', written: false };
    changes = wireSettingsChanges(current, wanted);
    if (changes.length === 0) return { outcome: 'unchanged' };
  }

  const body = bodyOf(current, wanted);
  await api.write(script, body);
  const after = await api.read(script);
  // What the read after must hold: the body as sent, and every secret read before (kept, not sent).
  const expected = snapshot([...body.bindings, ...current.filter((b) => SECRET.has(b.type))]);
  const differing = differingNames(expected, snapshot(after));
  if (differing.length > 0) return { outcome: 'verify', bindings: differing };
  if (opts.servedVersionAfter && (await opts.servedVersionAfter()) !== opts.servedVersion) return { outcome: 'serve-in-flight', written: true };
  return { outcome: 'updated', changes };
}

/**
 * The `WireSettingsApi` over the namespace's script-settings endpoint. A failure names the script and
 * the status only, never a response body: the body of a settings answer holds binding values.
 */
export function createWfpWireSettingsApi(opts: { readonly accountId: string; readonly namespace: string; readonly apiToken: string }): WireSettingsApi {
  const urlOf = (script: string) =>
    `https://api.cloudflare.com/client/v4/accounts/${opts.accountId}` +
    `/workers/dispatch/namespaces/${opts.namespace}/scripts/${encodeURIComponent(script)}/settings`;
  const auth = { authorization: `Bearer ${opts.apiToken}` };
  return {
    async read(script) {
      const res = await fetch(urlOf(script), { headers: auth });
      if (!res.ok) {
        await res.body?.cancel();
        throw new Error(`the settings of '${script}' could not be read (${res.status})`);
      }
      const parsed = (await res.json().catch(() => null)) as { result?: { bindings?: unknown }; bindings?: unknown } | null;
      const bindings = parsed?.result?.bindings ?? parsed?.bindings;
      if (!Array.isArray(bindings) || !bindings.every((b) => b && typeof b === 'object' && typeof b.type === 'string' && typeof b.name === 'string')) {
        throw new Error(`the settings of '${script}' did not read as a list of bindings`);
      }
      return bindings as ScriptBinding[];
    },
    async write(script, body) {
      const form = new FormData();
      form.set('settings', new Blob([JSON.stringify(body)], { type: 'application/json' }), 'settings.json');
      const res = await fetch(urlOf(script), { method: 'PATCH', headers: auth, body: form });
      await res.body?.cancel();
      if (!res.ok) throw new Error(`the settings of '${script}' could not be written (${res.status})`);
    },
  };
}
