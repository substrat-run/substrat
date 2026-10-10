/**
 * The template renderer: `{{name}}` placeholders filled from the topic's variables.
 *
 * Deliberately not a template language. A topic's text is the vertical's vocabulary, and the
 * one thing it needs from a renderer is substitution that cannot be turned against the
 * reader: a variable comes from event data — a title somebody typed — so it is HTML-escaped
 * wherever it lands in the HTML part, and stripped of line breaks in the subject, which is a
 * header. No conditionals or loops: a message that needs them is two topics, or a variable
 * the vertical composes.
 */

/** A template as a topic declares it. `html` is optional; without it, the text is escaped into one. */
export interface NotificationTemplate {
  subject: string;
  text: string;
  html?: string;
}

interface RenderedMessage {
  subject: string;
  text: string;
  html: string;
}

/**
 * Why a render refused: a placeholder with no variable, or a message that came out empty
 * (every word of it was a variable, and each was blank) — the platform refuses an empty
 * subject or body, so it is caught here, where the reason can still be recorded.
 */
type RenderResult = { ok: true; message: RenderedMessage } | { ok: false; reason: string };

const PLACEHOLDER = /\{\{\s*([A-Za-z0-9_.-]+)\s*\}\}/g;

const ESCAPES: Record<string, string> = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (c) => ESCAPES[c]!);
}

/** Every placeholder a template names. */
function placeholdersOf(template: NotificationTemplate): string[] {
  const names = new Set<string>();
  for (const part of [template.subject, template.text, template.html ?? '']) {
    for (const m of part.matchAll(PLACEHOLDER)) names.add(m[1]!);
  }
  return [...names];
}

/**
 * Render `template` with `vars`. A placeholder with no variable is reported, never rendered
 * as empty: a mail reading "Assigned: " is worse than none, and the caller records why.
 */
export function render(template: NotificationTemplate, vars: Readonly<Record<string, string>>): RenderResult {
  const missing = placeholdersOf(template).find((name) => !Object.hasOwn(vars, name));
  if (missing !== undefined) return { ok: false, reason: `missing_variable:${missing}` };

  const fill = (part: string, encode: (v: string) => string) =>
    part.replace(PLACEHOLDER, (_m, name: string) => encode(vars[name]!));

  const text = fill(template.text, (v) => v);
  // A header: a line break in a value would end it. Collapse rather than refuse — the
  // subject is still the right one, on one line.
  const subject = fill(template.subject, (v) => v.replace(/[\r\n]+/g, ' ')).trim();
  if (subject === '' || text.trim() === '') return { ok: false, reason: 'empty_message' };
  return {
    ok: true,
    message: {
      subject,
      text,
      html: template.html !== undefined ? fill(template.html, escapeHtml) : htmlOfText(text),
    },
  };
}

/** The text part as HTML: escaped, paragraphs at blank lines, `<br>` at single breaks. */
function htmlOfText(text: string): string {
  return text
    .split(/\r?\n\s*\r?\n/)
    .map((para) => `<p>${escapeHtml(para.trim()).replace(/\r?\n/g, '<br>')}</p>`)
    .join('\n');
}
