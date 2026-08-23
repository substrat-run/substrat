/**
 * Every string BlastRadius renders, and the markdown twin of the same facts.
 *
 * The data lives here rather than in the component's `<script setup>` because
 * `llms.mts` cannot import a `<script setup>` block: a fact typed into the
 * template renders on the page and vanishes from llms.txt. See the note at the
 * top of ./LayerStack.content.mts — the rule is the same one.
 *
 * `theLine` is imported rather than restated. The cosmetic/catastrophic split is
 * already the spine of the three-layer diagram, and two copies of a thesis is
 * exactly the drift this repo lints for everywhere else.
 */
import { theLine } from './LayerStack.content.mjs';

export { theLine };

/** A side of the line: who writes it, and what a mistake there costs. */
export interface Side {
  readonly name: string;
  readonly verdict: string;
  readonly chips: readonly string[];
}

export const above: Side = {
  name: 'What an agent writes',
  verdict: 'Mistakes are cosmetic',
  chips: ['screens', 'forms', 'workflows', 'reports', 'pricing', 'vocabulary'],
};

export const below: Side = {
  name: 'What the substrate owns',
  verdict: 'Mistakes are catastrophic',
  chips: ['tenancy', 'auth', 'migrations', 'integrations', 'audit', 'compliance'],
};

/**
 * The caption under the figure — the reason the split is architectural, not advisory.
 * Held once in markdown-ish source; the component renders `captionHtml` and the twin
 * renders the plain form, so the picture and its text cannot disagree.
 */
export const caption =
  'The layer where models are weakest is the layer where mistakes are fatal. ' +
  'So the split is structural rather than instructional: prompting a model to ' +
  '"be careful with tenancy" is a suggestion, and a `getScope` call that fails ' +
  'closed on a mismatched pair is a fact.';

/** The same sentence with its code spans marked up, for the template. */
export const captionHtml = caption.replace(/`([^`]+)`/g, '<code>$1</code>');

export function alt(): string {
  const side = (s: Side) =>
    `- **${s.name}** — ${s.verdict.toLowerCase()}: ${s.chips.join(', ')}.`;
  return [
    '**Diagram — the line.** Two bands either side of one boundary.',
    '',
    side(above),
    `- **${theLine.label}.** Above: ${theLine.above}. Below: ${theLine.below}.`,
    side(below),
    '',
    caption,
  ].join('\n');
}
