import type { ExplanationView } from './api.generated';

/**
 * AI-written text on the page (#1749): the rules the `AiText` block renders by, kept out of
 * the JSX so they can be asserted on. Every paragraph a model wrote carries the AI marker and a
 * provenance line, and the line is the server's count of what it read, never the model's.
 */

export type Provenance = NonNullable<ExplanationView['explanation']>['provenance'];

/** What the block shows, decided from one answer. */
export type AiState =
  | { kind: 'hidden' }
  | { kind: 'offer'; spent: boolean }
  | { kind: 'text'; text: string; current: boolean; spent: boolean };

/**
 * `hidden` when the deployment offers nothing (flag off, or a model it cannot run): a block that
 * cannot write anything is not drawn, rather than drawn disabled. `offer` before anything has
 * been written; `text` once something has, whether or not it still describes the data.
 */
export function aiState(view: ExplanationView): AiState {
  if (!view.available) return { kind: 'hidden' };
  const spent = budgetSpent(view);
  if (!view.explanation) return { kind: 'offer', spent };
  return { kind: 'text', text: view.explanation.text, current: view.explanation.current, spent };
}

export function budgetSpent(view: ExplanationView): boolean {
  const b = view.budget;
  return b !== null && (b.person.used >= b.person.limit || b.team.used >= b.team.limit);
}

/** "today’s limit": which ceiling a spent budget hit, in the words the button's note uses. */
export function spentNote(view: ExplanationView): string {
  const b = view.budget;
  if (!b) return '';
  return b.person.used >= b.person.limit
    ? `You have used today’s ${b.person.limit} AI explanations; they reset at midnight UTC.`
    : `This team has used today’s ${b.team.limit} AI explanations; they reset at midnight UTC.`;
}

const SOURCE_LABEL: Record<Provenance['sources'][number]['kind'], string> = {
  finding: 'the finding',
  'ops-failures': 'failure records',
  'sweep-runs': 'sweep runs',
  deploy: 'the deploy',
  'lifecycle-flow': 'the replay',
};
export const sourceLabel = (kind: Provenance['sources'][number]['kind']) => SOURCE_LABEL[kind] ?? kind;

/** HH:MM in the reader's own zone; a date in front when it was not written today. */
export function writtenAtLabel(iso: string, now = new Date()): string {
  const at = new Date(iso);
  const time = at.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' });
  return at.toDateString() === now.toDateString() ? time : `${at.toLocaleDateString('en-GB', { day: 'numeric', month: 'short' })} ${time}`;
}

/** "Written 15:58 from 212 failure records, 2 versions · 4 sources" — the design's line. */
export function provenanceLine(p: Provenance, now = new Date()): string {
  const n = p.sources.length;
  return `Written ${writtenAtLabel(p.writtenAt, now)} from ${p.summary} · ${n} ${n === 1 ? 'source' : 'sources'}`;
}

/** The preview's explanations (DEV_MOCK): one model call is a timer, and nothing leaves the page. */
export function mockExplanations(): {
  get: (subject: string) => Promise<ExplanationView>;
  write: (subject: string, text: string, summary: string) => Promise<ExplanationView>;
} {
  const filed = new Map<string, ExplanationView['explanation']>();
  let used = 0;
  const view = (subject: string): ExplanationView => ({
    available: true,
    reason: null,
    disclosure: { vendor: 'Cloudflare Workers AI', location: 'Cloudflare network', sent: 'Counts, codes, versions and redacted error messages' },
    explanation: filed.get(subject) ?? null,
    budget: { person: { used, limit: 20 }, team: { used, limit: 100 } },
  });
  return {
    get: async (subject) => view(subject),
    write: async (subject, text, summary) => {
      await new Promise((r) => setTimeout(r, 600));
      used += 1;
      const writtenAt = new Date().toISOString();
      filed.set(subject, {
        text,
        writtenAt,
        current: true,
        provenance: {
          writtenAt,
          model: 'cloudflare/@cf/meta/llama-3.3-70b-instruct-fp8-fast',
          since: new Date(Date.now() - 86_400_000).toISOString(),
          until: writtenAt,
          sources: [
            { kind: 'finding', count: null, href: '/observability?view=findings' },
            { kind: 'ops-failures', count: 42, href: null },
          ],
          summary,
        },
      });
      return view(subject);
    },
  };
}
