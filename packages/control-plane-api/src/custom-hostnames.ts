/**
 * The Cloudflare-for-SaaS custom-hostname provisioner (#305, control-plane.md §4.7).
 *
 * Binding a custom domain to a surface is not a status flip — it is DNS validation and
 * certificate issuance, which take time and can fail (routing.ts `hostnameStatus`). This
 * module is the seam that actually asks Cloudflare: `create` registers a custom hostname
 * and returns the DNS records the tenant must publish; `check` polls its validation +
 * cert state. Both map Cloudflare's many internal states onto the four the platform
 * exposes (`pending`/`verifying`/`active`/`failed`).
 *
 * It is pure web-standard `fetch` + JSON — no Cloudflare SDK, no node built-ins — so it
 * runs unchanged in a Worker (the control plane holds the token as a secret) or in node
 * (tests, a dev server). It is INJECTED into `createControlPlaneApi` exactly like
 * `createWfpUploader`, so this package holds no Cloudflare credential and the builder
 * never holds one (D-34). Absent ⇒ the bind route records the row `pending` and issuance
 * simply does not run (a self-host / dev environment with no CF-for-SaaS zone).
 */
import type {
  DnsRecord,
  HostnameBinding,
  HostnameStatus,
  PlatformActorId,
} from '@substrat-run/contracts';
import { getRegistrableDomain, isPublicSuffix, normalizeHost } from '@substrat-run/psl';

/** The subset of `fetch` this module uses — web-standard, injectable for tests. */
export type FetchFn = (input: string, init?: RequestInit) => Promise<Response>;

/** The normalized result of an issuance step — what the control plane persists. */
export interface CustomHostnameIssuance {
  /** Cloudflare's custom-hostname id (`ch_…` / a uuid). The handle a later poll needs. */
  customHostnameId: string;
  /** Mapped onto the platform's four states; never `pending` (create/poll has run). */
  status: Extract<HostnameStatus, 'verifying' | 'active' | 'failed'>;
  /** A human reason when `failed` (Cloudflare's verification errors), else null. */
  note: string | null;
  /** The DNS records the tenant must publish (routing CNAME + any DCV TXT). */
  records: DnsRecord[];
}

export interface CustomHostnameProvisioner {
  /** Register a custom hostname for issuance. Idempotent on Cloudflare's side per name. */
  create(hostname: string): Promise<CustomHostnameIssuance>;
  /** Poll a registered custom hostname's validation + certificate state. */
  check(customHostnameId: string): Promise<CustomHostnameIssuance>;
  /** Delete the Cloudflare custom hostname — the inverse of `create`, for an unbind. */
  remove(customHostnameId: string): Promise<void>;
}

export interface CustomHostnameProvisionerOptions {
  /** The Cloudflare zone (the tenant-apps zone, e.g. the `substrat.run` zone) id. */
  zoneId: string;
  /** A Cloudflare API token with SSL/custom-hostname write on the zone. Platform-held. */
  apiToken: string;
  /**
   * The CNAME value a tenant points their custom domain at — the SaaS fallback ingress
   * (e.g. `edge.substrat.run`). Surfaced verbatim as the routing record so the tenant
   * knows where to point DNS.
   */
  routingTarget: string;
  /**
   * DCV method. `txt` (default) validates via a TXT record and works before the domain
   * resolves; `http` validates by serving a token over the routing CNAME, so it needs
   * the CNAME live first. TXT is the safer default for a self-serve flow.
   */
  sslMethod?: 'txt' | 'http';
  /** Injectable fetch (defaults to the runtime `fetch`) — tests pass a stub. */
  fetch?: FetchFn;
}

/** Cloudflare's custom-hostname result shape (only the fields we read). */
interface CfCustomHostname {
  id: string;
  hostname: string;
  status?: string; // pending | pending_validation | active | blocked | moved | deleted | …
  verification_errors?: string[];
  ownership_verification?: { type?: string; name?: string; value?: string };
  ssl?: {
    status?: string; // initializing | pending_validation | pending_issuance | active | …
    validation_errors?: { message?: string }[];
    validation_records?: {
      txt_name?: string;
      txt_value?: string;
      status?: string;
    }[];
  };
}

interface CfEnvelope<T> {
  success: boolean;
  result?: T;
  errors?: { code?: number; message?: string }[];
}

/**
 * Is `hostname` a custom domain (one the platform issues a cert for), or a platform
 * mint that rides the wildcard? A platform mint is a hostname AT or UNDER one of the
 * platform's base domains (`substrat.run`, `global.substrat.run`, …). Everything else
 * is custom and walks the Cloudflare-for-SaaS issuance lifecycle.
 */
export function isCustomHostname(hostname: string, platformBaseDomains: string[]): boolean {
  const h = normalizeHost(hostname);
  return !platformBaseDomains.some((base) => {
    const b = normalizeHost(base);
    return h === b || h.endsWith(`.${b}`);
  });
}

/**
 * The registrable-suffix guard at bind time (#305, D-35): a custom hostname must be a
 * real registrable domain or a name under one — never a bare public suffix (`com`,
 * `co.uk`, `pages.dev`) that a tenant cannot own and whose cookie would span every
 * tenant beneath it. Returns an error message to reject with, or null when bindable.
 * Platform mints skip this (they are the platform's own registrable domain by
 * construction). Uses the vendored PSL, so `co.uk` is caught where a label-count check
 * would wave it through.
 */
export function validateBindableHostname(hostname: string): string | null {
  const h = normalizeHost(hostname);
  if (!h || !h.includes('.')) return `'${hostname}' is not a fully-qualified domain`;
  if (isPublicSuffix(h)) return `'${hostname}' is a public suffix — a cookie on it would span tenants`;
  if (getRegistrableDomain(h) === null) return `'${hostname}' has no registrable domain`;
  return null;
}

/** Bound a possibly-large upstream error body before it rides inside a thrown Error. */
function clip(body: string, max = 1000): string {
  return body.length <= max ? body : `${body.slice(0, max)} … [truncated, ${body.length - max} chars omitted]`;
}

/**
 * Map Cloudflare's hostname + SSL states onto the platform's four. The rule of thumb:
 * anything mid-flight (validation/issuance/deployment/initializing) is `verifying`; a
 * terminal bad state (blocked/moved/timed-out/expired, or explicit errors) is `failed`;
 * both hostname and cert `active` is `active`. Unknown strings default to `verifying`
 * rather than `failed` — a state we do not recognise is more likely new-than-broken, and
 * a stuck `verifying` is visible in the UI without falsely declaring a domain dead.
 */
export function mapCfStatus(ch: CfCustomHostname): {
  status: CustomHostnameIssuance['status'];
  note: string | null;
} {
  const host = (ch.status ?? '').toLowerCase();
  const ssl = (ch.ssl?.status ?? '').toLowerCase();
  const errors = [
    ...(ch.verification_errors ?? []),
    ...(ch.ssl?.validation_errors ?? []).map((e) => e?.message).filter((m): m is string => !!m),
  ];

  const FAILED_HOST = new Set(['blocked', 'moved', 'deleted']);
  const FAILED_SSL = new Set(['validation_timed_out', 'expired', 'deleted', 'deactivating']);
  if (FAILED_HOST.has(host) || FAILED_SSL.has(ssl)) {
    return { status: 'failed', note: errors.join('; ') || `cloudflare state: ${host || '?'}/${ssl || '?'}` };
  }
  if (host === 'active' && ssl === 'active') return { status: 'active', note: null };
  // Everything else is in flight. Surface any errors as a note without failing — a
  // transient validation error clears on the next poll.
  return { status: 'verifying', note: errors.join('; ') || null };
}

/** Extract the DNS records the tenant must publish from a CF custom-hostname result. */
export function extractRecords(ch: CfCustomHostname, routingTarget: string): DnsRecord[] {
  const records: DnsRecord[] = [
    // The routing CNAME — always needed, present from creation. Name is the full
    // hostname so a DNS UI can take it verbatim regardless of the tenant's zone apex.
    { type: 'hostname', name: ch.hostname, value: routingTarget, status: ch.status ?? null },
  ];
  // DCV TXT records (TXT method, or ownership verification). Deduped by name.
  const seen = new Set<string>();
  for (const r of ch.ssl?.validation_records ?? []) {
    if (r.txt_name && r.txt_value && !seen.has(r.txt_name)) {
      seen.add(r.txt_name);
      records.push({ type: 'txt', name: r.txt_name, value: r.txt_value, status: r.status ?? null });
    }
  }
  const ov = ch.ownership_verification;
  if (ov?.type === 'txt' && ov.name && ov.value && !seen.has(ov.name)) {
    records.push({ type: 'txt', name: ov.name, value: ov.value, status: null });
  }
  return records;
}

export function createCustomHostnameProvisioner(
  opts: CustomHostnameProvisionerOptions,
): CustomHostnameProvisioner {
  const fetchFn: FetchFn = opts.fetch ?? (globalThis.fetch as FetchFn);
  const base = `https://api.cloudflare.com/client/v4/zones/${opts.zoneId}/custom_hostnames`;
  const auth = { authorization: `Bearer ${opts.apiToken}` };

  const toIssuance = (ch: CfCustomHostname): CustomHostnameIssuance => {
    const { status, note } = mapCfStatus(ch);
    return { customHostnameId: ch.id, status, note, records: extractRecords(ch, opts.routingTarget) };
  };

  const readEnvelope = async (res: Response, what: string): Promise<CfCustomHostname> => {
    const text = await res.text().catch(() => '');
    let env: CfEnvelope<CfCustomHostname> | undefined;
    try {
      env = text ? (JSON.parse(text) as CfEnvelope<CfCustomHostname>) : undefined;
    } catch {
      // Non-JSON upstream body — fall through to the status-based error below.
    }
    if (!res.ok || !env?.success || !env.result) {
      const msg = env?.errors?.map((e) => e.message).filter(Boolean).join('; ') || clip(text);
      // An auth failure here is a PLATFORM misconfiguration, not the tenant's DNS: the
      // token works for other CF APIs but lacks the custom-hostname permission. Say so —
      // "Authentication error" alone reads as the tenant's problem and sends them to
      // their DNS provider instead of the operator to the token settings.
      const hint =
        res.status === 401 || res.status === 403
          ? " — the platform's Cloudflare API token lacks 'SSL and Certificates: Edit' on the SaaS zone (secrets/platform.<env>.env CF_API_TOKEN; a just-edited token can take a few minutes to propagate); not a DNS problem on the domain"
          : '';
      throw new Error(`Cloudflare ${what} failed (${res.status}): ${msg || 'unknown error'}${hint}`);
    }
    return env.result;
  };

  return {
    async create(hostname) {
      const res = await fetchFn(base, {
        method: 'POST',
        headers: { ...auth, 'content-type': 'application/json' },
        body: JSON.stringify({
          hostname: hostname.toLowerCase(),
          ssl: { method: opts.sslMethod ?? 'txt', type: 'dv', settings: { min_tls_version: '1.2' } },
        }),
      });
      return toIssuance(await readEnvelope(res, 'custom-hostname create'));
    },

    async check(customHostnameId) {
      const res = await fetchFn(`${base}/${encodeURIComponent(customHostnameId)}`, { headers: auth });
      return toIssuance(await readEnvelope(res, 'custom-hostname check'));
    },

    async remove(customHostnameId) {
      const res = await fetchFn(`${base}/${encodeURIComponent(customHostnameId)}`, {
        method: 'DELETE',
        headers: auth,
      });
      // A 404 means it is already gone — the DELETE is idempotent, like unbindHostname.
      if (!res.ok && res.status !== 404) {
        const text = await res.text().catch(() => '');
        throw new Error(`Cloudflare custom-hostname delete failed (${res.status}): ${clip(text)}`);
      }
    },
  };
}

/** The narrow admin surface the reconcile pass needs — a slice of `HostAdmin`. */
export interface HostnameReconcileAdmin {
  listHostnames(
    actor: PlatformActorId,
    filter?: { status?: HostnameStatus },
  ): Promise<HostnameBinding[]>;
  setHostnameIssuance(
    actor: PlatformActorId,
    hostname: string,
    fields: {
      status: HostnameStatus;
      note?: string | null;
      customHostnameId?: string | null;
      validationRecords: DnsRecord[];
    },
  ): Promise<void>;
}

export interface ReconcileHostnamesResult {
  /** Rows polled this pass (status `verifying` with a CF id). */
  polled: number;
  /** Rows that reached `active` this pass. */
  activated: number;
  /** Rows that moved to `failed` this pass. */
  failed: number;
  /** Custom rows (`pending`, or `failed` with no CF id) for which a CF create was (re)attempted. */
  created: number;
  /** Per-hostname errors — one bad row never sinks the pass. */
  errors: { hostname: string; error: string }[];
}

/**
 * One reconcile pass over in-flight custom hostnames (#305, §4.7). Two kinds of row:
 *
 *   - `verifying` with a CF id — poll Cloudflare and persist the new status/records; a
 *     `verifying → active` here is the automated flip that replaces the old manual one.
 *   - `pending` OR `failed` with NO CF id but a custom hostname — a create that never
 *     landed (the bind route failed transiently, ran before a provisioner was configured,
 *     or hit a misconfigured credential and was recorded `failed`). Retry the create so
 *     the row self-heals once the cause is fixed, instead of waiting on a human click.
 *
 * `isCustom` decides which `pending` rows are ours to issue for — a platform hostname
 * (rides the wildcard, no CF object) is never touched here. Per-row failures are caught
 * and reported, never thrown, so the sweep that calls this stays alive (scheduler.md).
 */
export async function reconcilePendingHostnames(deps: {
  admin: HostnameReconcileAdmin;
  actor: PlatformActorId;
  provisioner: CustomHostnameProvisioner;
  /** True for a hostname the platform issues certs for (a custom domain), false for a platform mint. */
  isCustom: (hostname: string) => boolean;
}): Promise<ReconcileHostnamesResult> {
  const out: ReconcileHostnamesResult = { polled: 0, activated: 0, failed: 0, created: 0, errors: [] };

  const verifying = await deps.admin.listHostnames(deps.actor, { status: 'verifying' });
  for (const h of verifying) {
    if (!h.customHostnameId) continue; // nothing to poll — a create must land first
    try {
      out.polled++;
      const r = await deps.provisioner.check(h.customHostnameId);
      await deps.admin.setHostnameIssuance(deps.actor, h.hostname, {
        status: r.status,
        note: r.note,
        validationRecords: r.records,
      });
      if (r.status === 'active') out.activated++;
      else if (r.status === 'failed') out.failed++;
    } catch (err) {
      out.errors.push({ hostname: h.hostname, error: err instanceof Error ? err.message : String(err) });
    }
  }

  // `failed` rows WITHOUT a CF id are creates that never landed (e.g. a token without
  // the custom-hostname permission) — retriable exactly like a stuck `pending`, so a
  // fixed credential heals them on the next sweep. `failed` WITH an id stays terminal
  // here: that is a real validation verdict, re-checked only by an explicit verify.
  const failed = (await deps.admin.listHostnames(deps.actor, { status: 'failed' })).filter(
    (h) => !h.customHostnameId,
  );
  const pending = await deps.admin.listHostnames(deps.actor, { status: 'pending' });
  for (const h of [...pending, ...failed]) {
    if (h.customHostnameId || !deps.isCustom(h.hostname)) continue; // already created, or a platform mint
    try {
      const r = await deps.provisioner.create(h.hostname);
      await deps.admin.setHostnameIssuance(deps.actor, h.hostname, {
        status: r.status,
        note: r.note,
        customHostnameId: r.customHostnameId,
        validationRecords: r.records,
      });
      out.created++;
    } catch (err) {
      out.errors.push({ hostname: h.hostname, error: err instanceof Error ? err.message : String(err) });
    }
  }
  return out;
}
