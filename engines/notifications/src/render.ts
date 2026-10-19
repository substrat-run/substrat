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

export interface RenderedMessage {
  subject: string;
  text: string;
  html: string;
}

/**
 * Why a render refused: a placeholder with no variable, or a part — subject, text or a
 * declared html — that came out empty because every word of it was a blank variable. The
 * platform refuses an empty part, so it is caught here, where the reason names the part.
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
  const html = template.html !== undefined ? fill(template.html, escapeHtml) : htmlOfText(text);
  const empty = Object.entries({ subject, text, html }).find(([, part]) => part.trim() === '');
  if (empty) return { ok: false, reason: `empty_message:${empty[0]}` };
  return { ok: true, message: { subject, text, html } };
}

/**
 * One mail out of the messages held for a person's digest, oldest first.
 *
 * Every word in it is the vertical's: a digest of one message is that message, and a digest of
 * several is the first one's subject marked `(+N)`, with each message under its own subject.
 * The engine adds only that count and the rules between them, so a workshop that writes its
 * notifications in Swedish does not receive an English digest. Each message was rendered — and
 * its variables escaped — when it was held; a subject is header text, so it is escaped here
 * before it becomes a heading.
 */
export function digestOf(messages: readonly RenderedMessage[]): RenderedMessage {
  const [first, ...rest] = messages;
  if (first === undefined) throw new Error('digestOf: a digest needs at least one message');
  // The three parts and nothing else: a held row carries more, and a send intent refuses it.
  if (rest.length === 0) return { subject: first.subject, text: first.text, html: first.html };
  return {
    subject: `${first.subject} (+${rest.length})`,
    text: messages.map((m) => `${m.subject}\n\n${m.text}`).join('\n\n----\n\n'),
    html: messages.map((m) => `<section>\n<h2>${escapeHtml(m.subject)}</h2>\n${m.html}\n</section>`).join('\n<hr>\n'),
  };
}

/** The text part as HTML: escaped, paragraphs at blank lines, `<br>` at single breaks. */
function htmlOfText(text: string): string {
  return text
    .split(/\r?\n\s*\r?\n/)
    .map((para) => `<p>${escapeHtml(para.trim()).replace(/\r?\n/g, '<br>')}</p>`)
    .join('\n');
}
