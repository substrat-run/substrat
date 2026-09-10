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
import { createClient } from './api.generated.js';

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

async function bytesRoute(url: string, init: RequestInit): Promise<IngestResult> {
  const res = await fetch(url, { credentials: 'same-origin', ...init });
  const body = (await res.json().catch(() => ({}))) as Partial<IngestResult> & { error?: string };
  if (!res.ok) throw new Error(body.error ?? `${res.status}`);
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
