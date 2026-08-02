/**
 * `GET /auth/whoami` — the signed-in user + the tenants they can build for
 * (builder-plane.md §5). `substrat login` calls it to store a default tenant (and to
 * prompt when a user belongs to several); a bare `whoami` command prints it.
 */
import { readJson } from './http.js';

export interface Whoami {
  user: { id: string; email?: string } | null;
  tenants: { id: string; slug: string; name: string }[];
}

export async function fetchWhoami(controlPlaneUrl: string, header: Record<string, string>): Promise<Whoami> {
  const base = controlPlaneUrl.replace(/\/$/, '');
  const url = `${base}/auth/whoami`;
  const res = await fetch(url, { headers: header });
  if (!res.ok) {
    throw new Error(`whoami failed (${res.status}): ${(await res.text().catch(() => res.statusText)).slice(0, 200)}`);
  }
  return readJson<Whoami>(res, url);
}
