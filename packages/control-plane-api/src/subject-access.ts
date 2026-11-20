/**
 * The subject access package (GDPR Art. 15, D-74, `docs/rfc/subject-access.md` §3.3–§3.4), assembled
 * from the pages `readSubject` returns, and the receipt the admin log keeps of it.
 *
 * Pure: no admin, no network. The route reads the pages, hands them here, records the receipt and
 * returns the package with its HTML page.
 *
 * **Other people in the subject's rows (Art. 15(4)).** A matched row's subject columns that hold a
 * different id, and every event actor who is not the subject, are replaced by the pseudonymizer the
 * masked exports use, with a fresh salt per package, so the same colleague reads as the same token
 * across rows and events. The kind of actor stays visible. Event payloads and erasable fields are
 * returned as recorded: they are the subject's, and the controller reviews the package before
 * anything reaches the person.
 */
import type {
  Actor,
  SubjectAccessReceipt,
  SubjectEvent,
  SubjectReadPage,
  SubjectRecords,
  UnreachedEntity,
} from '@substrat-run/contracts';
import { createPseudonymizer, type Pseudonymizer } from './pseudonymize.js';

export const SUBJECT_ACCESS_KIND = 'substrat.subject-access/v1';

/** The limits every package states (§5), so the controller reads the gaps in the package. */
export const SUBJECT_ACCESS_LIMITS = [
  'attachments',
  'free-text',
  'unclassified-events',
  'events-without-subject',
  'request-logs',
] as const;

/** Where copies of a scope's data live, and for how long: listed, never read (§3.2). */
export const SUBJECT_ACCESS_STORAGE = [
  {
    copy: 'point-in-time recovery',
    retention: 'about 30 days, rolling',
  },
  {
    copy: 'backup',
    retention: 'kept until the scope is deleted; event payloads about a person are sealed under their own key',
  },
  {
    copy: 'lake',
    retention: 'event history shipped for analysis; not reached by erasure (kernel-design.md §13.1, limit 6)',
  },
] as const;

/** An actor as the package names it: what kind it was, and who only when it is the subject. */
export interface PackageActor {
  kind: 'subject' | 'person' | 'system' | 'connector' | 'capability' | 'app';
  ref?: string;
}

export interface PackageEvent {
  id: string;
  type: string;
  occurredAt: string;
  operation: string | null;
  entity: { entityType: string; entityId: string };
  actor: PackageActor;
  piiClass: string;
  payload: unknown;
  erased: boolean;
}

export interface PackageRecords {
  module: string;
  entityType: string;
  mode: 'blank' | 'delete';
  rows: Record<string, unknown>[];
  maskedColumns: string[];
}

export interface SubjectAccessPackage {
  kind: typeof SUBJECT_ACCESS_KIND;
  subjectId: string;
  tenantId: string;
  scopeId: string;
  jurisdiction: string;
  vertical: { slug: string | null; versionId: string | null };
  generatedAt: string;
  reference: string;
  events: PackageEvent[];
  records: PackageRecords[];
  bindings: never[];
  stores: never[];
  categories: { entities: { entityType: string; fields: string[] }[]; events: string[] };
  storage: typeof SUBJECT_ACCESS_STORAGE;
  recipients: { status: 'not-available'; reason: string };
  unreached: { entities: UnreachedEntity[]; limits: typeof SUBJECT_ACCESS_LIMITS };
}

export interface SubjectAccessInput {
  tenantId: string;
  scopeId: string;
  subjectId: string;
  jurisdiction: string;
  vertical: { slug: string | null; versionId: string | null };
  generatedAt: string;
  reference: string;
  pages: readonly SubjectReadPage[];
  /** One per package, so tokens do not join across packages. */
  salt: string;
}

/**
 * A subject column's value as an id, or null when it holds none. Not only strings: the match compares
 * the column with the id as text, so a column of any affinity can match, and another person's id
 * stored as a number must be masked as surely as one stored as text.
 */
const idIn = (v: unknown): string | null => (v === null || v === undefined ? null : String(v));

/** Fold the pages: events in order, each entity's rows concatenated under its first listing. */
function fold(pages: readonly SubjectReadPage[]) {
  const events: SubjectEvent[] = [];
  const records = new Map<string, SubjectRecords>();
  for (const page of pages) {
    events.push(...page.events);
    for (const r of page.records) {
      const key = JSON.stringify([r.module, r.entityType]);
      const held = records.get(key);
      if (held) held.rows.push(...r.rows);
      else records.set(key, { ...r, rows: [...r.rows] });
    }
  }
  const first = pages[0];
  return {
    events,
    records: [...records.values()],
    unreachedEntities: first?.unreachedEntities ?? [],
    hookEntities: first?.hookEntities ?? [],
  };
}

function actorOf(actor: Actor, subjectId: string, mask: Pseudonymizer): PackageActor {
  if (typeof actor === 'string') {
    return actor === subjectId ? { kind: 'subject', ref: subjectId } : { kind: 'person', ref: mask.valueFor('external_id', actor) };
  }
  if ('system' in actor) return { kind: 'system' };
  if ('connection' in actor) return { kind: 'connector' };
  if ('capability' in actor) return { kind: 'capability' };
  return { kind: 'app' };
}

/** Assemble the package and its receipt from the pages one request read. */
export async function assembleSubjectAccess(
  input: SubjectAccessInput,
): Promise<{ package: SubjectAccessPackage; receipt: SubjectAccessReceipt }> {
  const { subjectId } = input;
  const folded = fold(input.pages);
  const mask = await createPseudonymizer(input.salt);

  // Every value the mask will replace, prepared in one batch: other people's ids in subject
  // columns, and every principal who acted.
  const others = new Set<string>();
  for (const r of folded.records) {
    for (const row of r.rows) {
      for (const col of r.subjects) {
        const id = idIn(row[col]);
        if (id !== null && id !== subjectId) others.add(id);
      }
    }
  }
  for (const e of folded.events) if (typeof e.actor === 'string' && e.actor !== subjectId) others.add(e.actor);
  await mask.prepare(others);

  const records: PackageRecords[] = folded.records.map((r) => {
    const masked = new Set<string>();
    const rows = r.rows.map((row) => {
      const out = { ...row };
      for (const col of r.subjects) {
        const id = idIn(out[col]);
        if (id !== null && id !== subjectId) {
          out[col] = mask.valueFor('external_id', id);
          masked.add(col);
        }
      }
      return out;
    });
    return { module: r.module, entityType: r.entityType, mode: r.mode, rows, maskedColumns: [...masked].sort() };
  });

  const events: PackageEvent[] = folded.events.map((e) => ({
    id: e.id,
    type: e.type,
    occurredAt: e.occurredAt,
    operation: e.operation,
    entity: e.entity,
    actor: actorOf(e.actor, subjectId, mask),
    piiClass: e.piiClass,
    payload: e.payload,
    erased: e.erased,
  }));

  // Derived, never written: the erasable fields of each entity that returned rows, and the classes
  // of the events returned.
  const categories = {
    entities: folded.records
      .filter((r) => r.rows.length > 0 && r.erasable.length > 0)
      .map((r) => ({ entityType: r.entityType, fields: [...r.erasable] })),
    events: [...new Set(folded.events.map((e) => e.piiClass))].sort(),
  };

  const residencyExempt = input.jurisdiction !== 'global';
  const pkg: SubjectAccessPackage = {
    kind: SUBJECT_ACCESS_KIND,
    subjectId,
    tenantId: input.tenantId,
    scopeId: input.scopeId,
    jurisdiction: input.jurisdiction,
    vertical: input.vertical,
    generatedAt: input.generatedAt,
    reference: input.reference,
    events,
    records,
    bindings: [],
    stores: [],
    categories,
    storage: SUBJECT_ACCESS_STORAGE,
    recipients: { status: 'not-available', reason: 'the disclosure register is not built' },
    unreached: { entities: [...folded.unreachedEntities, ...folded.hookEntities], limits: SUBJECT_ACCESS_LIMITS },
  };
  const receipt: SubjectAccessReceipt = {
    subjectId,
    generatedAt: input.generatedAt,
    reference: input.reference,
    requesterVerified: true,
    jurisdiction: input.jurisdiction,
    residencyExempt,
    events: events.length,
    erasedEvents: events.filter((e) => e.erased).length,
    records: records.map((r) => ({ module: r.module, entityType: r.entityType, rows: r.rows.length })),
    stores: [],
    unreachedEntities: folded.unreachedEntities,
    hookEntities: folded.hookEntities,
    recipients: 'not-available',
  };
  return { package: pkg, receipt };
}

const escapeHtml = (s: string): string =>
  s.replace(/[&<>"']/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[ch]!);

const cell = (v: unknown): string =>
  v === null || v === undefined ? '<span class="none">—</span>' : escapeHtml(typeof v === 'string' ? v : JSON.stringify(v));

/**
 * The package as one self-contained HTML page for the person: no script, no external resource. It
 * uses the entity and field names the model declares, because the model declares no display
 * labels; translating them for a reader is the controller's.
 */
export function renderSubjectAccessHtml(pkg: SubjectAccessPackage): string {
  const records = pkg.records
    .filter((r) => r.rows.length > 0)
    .map((r) => {
      const cols = [...new Set(r.rows.flatMap((row) => Object.keys(row)))];
      const head = cols.map((c) => `<th>${escapeHtml(c)}</th>`).join('');
      const body = r.rows.map((row) => `<tr>${cols.map((c) => `<td>${cell(row[c])}</td>`).join('')}</tr>`).join('');
      return `<section><h3>${escapeHtml(r.entityType)}</h3><table><thead><tr>${head}</tr></thead><tbody>${body}</tbody></table></section>`;
    })
    .join('');
  const events = pkg.events
    .map(
      (e) =>
        `<tr><td>${cell(e.occurredAt)}</td><td>${cell(e.type)}</td><td>${cell(e.entity.entityType)}</td>` +
        `<td>${cell(e.actor.kind)}</td><td>${e.erased ? '<em>erased</em>' : cell(e.payload)}</td></tr>`,
    )
    .join('');
  const unreached = pkg.unreached.entities.map((u) => `<li>${escapeHtml(u.entityType)}</li>`).join('');
  const storage = pkg.storage.map((s) => `<li><strong>${escapeHtml(s.copy)}</strong>: ${escapeHtml(s.retention)}</li>`).join('');
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>Personal data held about ${escapeHtml(pkg.subjectId)}</title>
<style>
body{font:14px/1.5 system-ui,sans-serif;margin:2rem auto;max-width:72rem;padding:0 1rem;color:#1d1d1f}
table{border-collapse:collapse;width:100%;margin:.5rem 0 1.5rem}th,td{border:1px solid #d2d2d7;padding:.35rem .5rem;text-align:left;vertical-align:top;word-break:break-word}
th{background:#f5f5f7}.none{color:#86868b}h1{font-size:1.5rem}h2{margin-top:2rem}
</style></head><body>
<h1>Personal data held about ${escapeHtml(pkg.subjectId)}</h1>
<p>Generated ${escapeHtml(pkg.generatedAt)}. Reference ${escapeHtml(pkg.reference)}.</p>
<h2>Records</h2>${records || '<p>No records.</p>'}
<h2>Events</h2>${
    pkg.events.length
      ? `<table><thead><tr><th>When</th><th>What</th><th>About</th><th>By</th><th>Recorded</th></tr></thead><tbody>${events}</tbody></table>`
      : '<p>No events.</p>'
  }
<h2>Categories of data</h2><p>${escapeHtml(pkg.categories.entities.map((c) => `${c.entityType}: ${c.fields.join(', ')}`).join('; ') || 'No records.')}</p>
<p>Events: ${escapeHtml(pkg.categories.events.join(', ') || 'none')}.</p>
<h2>Where copies are kept</h2><ul>${storage}</ul>
<h2>Recipients</h2><p>Not available from the platform: ${escapeHtml(pkg.recipients.reason)}.</p>
<h2>Not covered by this copy</h2>${unreached ? `<ul>${unreached}</ul>` : ''}<p>${escapeHtml(pkg.unreached.limits.join(', '))}</p>
</body></html>
`;
}
