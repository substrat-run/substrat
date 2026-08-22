/**
 * The markdown twin of every theme component that carries facts.
 *
 * `toTwin` used to flatten `<LayerStack />` to a pointer at the HTML page, on the
 * grounds that a diagram cannot be flattened honestly. That is true of a drawing
 * and false of these: both components render ordinary prose out of ordinary
 * arrays, so what the pointer dropped was content that already existed — and
 * dropped it from llms.txt, the surface agents read.
 *
 * Each entry renders its markdown from the same data its component renders from
 * (see the sibling `*.content.mts`), so the twin cannot drift from the picture. A
 * component with no entry here still gets the pointer, which is the honest
 * answer for a drawing; `lint:llms --check` fails on one that is merely
 * forgotten — see `ALT_NOT_NEEDED` in tools/llms-index.mts.
 */
import { alt as connectorLoop } from './ConnectorLoop.content.mjs';
import { alt as layerStack } from './LayerStack.content.mjs';
import { alt as runtimeTopology } from './RuntimeTopology.content.mjs';
import { alt as scopeTopology } from './ScopeTopology.content.mjs';

export const COMPONENT_ALT: Record<string, () => string> = {
  ConnectorLoop: connectorLoop,
  LayerStack: layerStack,
  RuntimeTopology: runtimeTopology,
  ScopeTopology: scopeTopology,
};

/** The twin for `<Name />`, or null when the component has no flattening. */
export function altFor(component: string): string | null {
  return COMPONENT_ALT[component]?.() ?? null;
}
