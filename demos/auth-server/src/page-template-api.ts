import type { SqlExec } from './introspect.js';
import { log } from './log.js';
import {
  MAX_TEMPLATE_BYTES,
  deletePageTemplate,
  putPageTemplate,
  templateFingerprint,
  templateProblems,
} from './page-template.js';

/**
 * Setting and removing the install's page template (#3350) — the one implementation behind both
 * doors: Auth0's `/api/v2/branding/templates/universal-login` for a machine client holding
 * `update:branding`/`delete:branding`, and the console's `/api/admin/branding/…` for an
 * administrator. Each door answers in its own error shape; what is judged and stored is this.
 *
 * Every change is a log line naming who made it (an administrator's user id, or a machine
 * client's id) with the template's size and a digest prefix — never the template itself. That
 * is the issuer's only record of it: the issuer keeps no audit table for settings, and the other
 * settings writes do not log at all.
 */

/** Who changed the template, for the log line. */
export type TemplateActor = { admin: string } | { client: string };

/**
 * The template out of a PUT body, the ways Auth0 accepts one: JSON `{ "template": "…" }` or a
 * bare JSON string, a form with a `template` field, or the HTML itself as `text/html`.
 */
export function templateFromBody(contentType: string | undefined, raw: string): { template: unknown } | { error: string } {
  // Far past the limit is refused before parsing, in the limit's own words.
  if (raw.length > MAX_TEMPLATE_BYTES * 4) return { error: `Payload content length greater than maximum allowed: ${MAX_TEMPLATE_BYTES}.` };
  const type = (contentType ?? '').split(';')[0]!.trim().toLowerCase();
  if (type === 'text/html') return { template: raw };
  if (type === 'application/x-www-form-urlencoded') {
    const template = new URLSearchParams(raw).get('template');
    return template === null ? { error: 'template is required' } : { template };
  }
  let body: unknown;
  try {
    body = JSON.parse(raw);
  } catch {
    return { error: 'the body must be JSON: { "template": "<html>…" }' };
  }
  if (typeof body === 'string') return { template: body };
  if (body && typeof body === 'object' && !Array.isArray(body)) {
    const keys = Object.keys(body);
    const extra = keys.filter((k) => k !== 'template');
    if (extra.length) return { error: `Payload validation error: 'Additional properties not allowed: ${extra.join(', ')}'.` };
    if (!keys.includes('template')) return { error: `Payload validation error: 'Missing required property: template'.` };
    return { template: (body as { template: unknown }).template };
  }
  return { error: 'the body must be JSON: { "template": "<html>…" }' };
}

/** Judge and store a template. Refused with its problems, or stored and logged. */
export async function saveTemplate(
  sql: SqlExec,
  template: unknown,
  actor: TemplateActor,
): Promise<{ problems: string[] } | { outcome: 'created' | 'updated' }> {
  const problems = templateProblems(template);
  if (problems.length) return { problems };
  const outcome = putPageTemplate(sql, template as string);
  log.info('page template saved', { outcome, by: actor, ...(await templateFingerprint(template as string)) });
  return { outcome };
}

/** Remove the template, logged when there was one. */
export function removeTemplate(sql: SqlExec, actor: TemplateActor): void {
  if (deletePageTemplate(sql)) log.info('page template deleted', { by: actor });
}
