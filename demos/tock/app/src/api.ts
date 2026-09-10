/**
 * The auth seam and the two host routes — the only parts of this client a person writes.
 *
 * Everything else is `api.generated.ts`: the types are the entities' `fields`, the methods are
 * the `http` declarations, and `pnpm lint:client` re-emits both from `spec/model.ts`.
 *
 * What is genuinely NOT in the model is which identity a request carries — the session cookie
 * set by the relying-party flow — and the two routes that carry BYTES. Upload and profile are
 * host routes precisely because module code cannot touch a blob, so no generated method could
 * exist for them: they are not operations.
 */
import { ApiError, createClient } from './api.generated.js';

export { ApiError } from './api.generated.js';
export type {
  FieldHistory, Observation, Paged, Row, Run, RuleState, Schema, Source, TockClient,
} from './api.generated.js';

export interface Session {
  principal: string;
  display: string;
}

export async function me(): Promise<Session | null> {
  const res = await fetch('/api/me', { credentials: 'same-origin' });
  return res.ok ? ((await res.json()) as Session) : null;
}

export const auth = {
  login: (returnTo = '/') => location.assign(`/api/auth/login?returnTo=${encodeURIComponent(returnTo)}`),
  switchUser: () => location.assign('/api/auth/login?prompt=select_account'),
  logout: () => location.assign('/api/auth/logout'),
};

export const api = createClient({
  fetch: (input, init) => fetch(input, { credentials: 'same-origin', ...init }),
});

/** What the two byte-carrying host routes answer with. */
export interface IngestResult {
  run: { id: string; status: string; row_count: number | null };
  records: number;
  malformed: number;
}

/**
 * These two routes are not operations, but a caller cannot tell and should not have to.
 *
 * `ApiError`, not a plain `Error`: the app decides what a refusal READS like by branching on
 * the error type and its status, so a plain throw here meant a 403 from upload rendered the
 * server's raw text while a 403 from any generated method rendered the sentence about roles.
 * Same failure, two voices, decided by whether the endpoint happened to be an operation.
 */
async function bytesRoute(url: string, init: RequestInit): Promise<IngestResult> {
  const res = await fetch(url, { credentials: 'same-origin', ...init });
  const body = (await res.json().catch(() => ({}))) as Partial<IngestResult> & { error?: string };
  if (!res.ok) throw new ApiError(res.status, body.error ?? res.statusText ?? `${res.status}`, body);
  return body as IngestResult;
}

/** Hand the file over. The server hashes it, stores it and reads the period out of it. */
export const upload = (sourceKey: string, filename: string, file: File) =>
  bytesRoute(`/api/sources/${encodeURIComponent(sourceKey)}/upload?filename=${encodeURIComponent(filename)}`, {
    method: 'POST',
    body: file,
  });

/** Ask the server to read those bytes back and profile from them. */
export const profile = (runId: string) =>
  bytesRoute(`/api/runs/${encodeURIComponent(runId)}/profile`, { method: 'POST' });

/**
 * Every page of a paged read, not just the first.
 *
 * A list read answers 20 entries and a `next` link; taking only the first page means the 21st
 * source in a workspace becomes unreachable rather than merely unshown. These collections are
 * small — sources, schema versions, a source's runs — so walking them whole is the honest
 * shape. A read that could grow without bound (rows) is not walked this way and gets its own
 * paging when it needs one.
 */
export async function all<T>(first: Promise<{ entries: T[]; next: string | null }>): Promise<T[]> {
  let page = await first;
  const out = [...page.entries];
  // A guard rather than a limit: a `next` that never goes null would otherwise spin forever.
  for (let hops = 0; page.next && hops < 50; hops += 1) {
    page = await api.follow<T>(page.next);
    out.push(...page.entries);
  }
  return out;
}
