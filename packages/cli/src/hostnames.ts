/**
 * `substrat hostnames` — the CLI half of surface hostname binding (K-26 multi-surface;
 * control-plane.md §4.7). One scope can front several apps; the hostname decides which
 * surface the vertical serves (`readRoutedNode(...).surface`). The dashboard's Domains
 * tab is the interactive path; this is CI-and-support parity over the same tenant-
 * narrowed control-plane routes (a builder session reaches only its own tenant's rows).
 *
 * A PLATFORM hostname is minted from the install's own default label —
 * `crm.global.substrat.run` + surface `eka` → `crm-eka.global.substrat.run` — and is
 * live immediately (it rides the wildcard cert). A CUSTOM domain lands `pending` and
 * walks the §4.2 DNS-validation lifecycle.
 */

/** One binding row as the control plane returns it (contracts' HostnameBinding). */
export interface HostnameRow {
  hostname: string;
  tenantId: string;
  scopeId: string;
  verticalSlug: string | null;
  surface: string;
  status: string;
  statusNote: string | null;
  canonical: boolean;
  createdAt: string;
}

async function request<T>(url: string, header: Record<string, string>, init?: RequestInit): Promise<T> {
  const res = await fetch(url, { ...init, headers: { 'content-type': 'application/json', ...header } });
  const body = await res.text();
  if (!res.ok) {
    let message = body;
    try {
      message = (JSON.parse(body) as { error?: string }).error ?? body;
    } catch {
      // Not JSON — the raw body is the message.
    }
    throw new Error(`${res.status}: ${message}`);
  }
  return JSON.parse(body) as T;
}

/** The tenant's bindings for one vertical — matched bare or `<tenant>/<slug>`-prefixed. */
export async function listVerticalHostnames(
  controlPlaneUrl: string,
  header: Record<string, string>,
  tenantId: string,
  slug: string,
): Promise<HostnameRow[]> {
  const base = controlPlaneUrl.replace(/\/$/, '');
  const rows = await request<HostnameRow[]>(`${base}/hostnames?tenantId=${encodeURIComponent(tenantId)}`, header);
  return rows.filter((h) => h.verticalSlug === slug || (h.verticalSlug ?? '').endsWith(`/${slug}`));
}

const slugifyLabel = (name: string): string =>
  name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || 'surface';

/**
 * Bind a hostname to one surface of an install. The install is addressed by its
 * vertical slug; the scope is found through the bindings that already exist (every
 * install got a default hostname at provisioning) — several installs of the same
 * vertical need an explicit `--scope`.
 */
export async function bindSurfaceHostname(opts: {
  controlPlaneUrl: string;
  header: Record<string, string>;
  tenantId: string;
  slug: string;
  surface: string;
  /** A custom domain to bind; omitted ⇒ mint a platform hostname for the surface. */
  domain?: string;
  /** Disambiguates when the tenant runs several installs of the vertical. */
  scope?: string;
}): Promise<{ hostname: string; status: string; canonical: boolean }> {
  const base = opts.controlPlaneUrl.replace(/\/$/, '');
  const rows = await listVerticalHostnames(opts.controlPlaneUrl, opts.header, opts.tenantId, opts.slug);
  const scopes = [...new Set(rows.map((h) => h.scopeId))];
  const scopeId = opts.scope ?? (scopes.length === 1 ? scopes[0] : undefined);
  if (!scopeId) {
    if (scopes.length === 0) {
      throw new Error(`no install of '${opts.slug}' has a hostname in this workspace — is it provisioned?`);
    }
    throw new Error(`'${opts.slug}' runs in several scopes — pass --scope <id>:\n  ${scopes.join('\n  ')}`);
  }
  const own = rows.filter((h) => h.scopeId === scopeId);
  // First binding for a (scope, surface) is canonical; later ones are aliases —
  // adding never silently demotes the URL a surface already serves on.
  const canonical = !own.some((h) => h.surface === opts.surface);

  const bind = (hostname: string) =>
    request<HostnameRow>(`${base}/hostnames`, opts.header, {
      method: 'POST',
      body: JSON.stringify({ hostname, tenantId: opts.tenantId, scopeId, surface: opts.surface, canonical }),
    });

  if (opts.domain) {
    const bound = await bind(opts.domain.toLowerCase());
    return { hostname: bound.hostname, status: bound.status, canonical };
  }

  // Platform mint: the install's default label + the surface, on the same base domain.
  const source =
    own.find((h) => h.canonical && h.surface === 'app') ?? own.find((h) => h.canonical) ?? own[0];
  if (!source || !source.hostname.includes('.')) {
    throw new Error(`no platform hostname to derive from — bind a --domain instead`);
  }
  const [label, ...rest] = source.hostname.split('.');
  const candidates = [
    `${label}-${slugifyLabel(opts.surface)}`,
    `${label}-${slugifyLabel(opts.surface)}-${scopeId.toLowerCase().slice(-4)}`,
  ].map((l) => `${l}.${rest.join('.')}`);
  let lastError: Error | undefined;
  for (const hostname of candidates) {
    try {
      await bind(hostname);
      await request(`${base}/hostnames/${encodeURIComponent(hostname)}/status`, opts.header, {
        method: 'PATCH',
        body: JSON.stringify({ status: 'active' }),
      });
      return { hostname, status: 'active', canonical };
    } catch (e) {
      lastError = e instanceof Error ? e : new Error(String(e)); // collision — try the tailed label
    }
  }
  throw lastError ?? new Error('could not bind a platform hostname');
}

/** Unbind one hostname. Tenant-narrowed server-side: a foreign hostname is a 404. */
export async function unbindHostname(
  controlPlaneUrl: string,
  header: Record<string, string>,
  hostname: string,
): Promise<void> {
  const base = controlPlaneUrl.replace(/\/$/, '');
  await request(`${base}/hostnames/${encodeURIComponent(hostname)}`, header, { method: 'DELETE' });
}

/** Render bindings as the aligned table `substrat hostnames <slug>` prints. */
export function formatHostnames(rows: HostnameRow[]): string {
  if (rows.length === 0) return '(no hostnames bound)';
  const width = Math.max(...rows.map((h) => h.hostname.length));
  return rows
    .map((h) =>
      [
        h.hostname.padEnd(width),
        h.surface.padEnd(12),
        (h.canonical ? `${h.status} *` : h.status).padEnd(11),
        h.scopeId,
      ].join('  '),
    )
    .join('\n');
}
