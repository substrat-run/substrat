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
import { alt as permissionPipeline } from './PermissionPipeline.content.mjs';
import { alt as instanceResolution } from './InstanceResolution.content.mjs';
import { alt as tenancyTree } from './TenancyTree.content.mjs';
import { alt as readPaths } from './ReadPaths.content.mjs';
import { alt as connectorLoop } from './ConnectorLoop.content.mjs';
import { alt as stateMachine } from './StateMachine.content.mjs';
import { alt as layerStack } from './LayerStack.content.mjs';
import { alt as runtimeTopology } from './RuntimeTopology.content.mjs';
import { alt as scopeTopology } from './ScopeTopology.content.mjs';
import { alt as blastRadius } from './BlastRadius.content.mjs';
import { alt as guardPath } from './GuardPath.content.mjs';

export const COMPONENT_ALT: Record<string, (props: Record<string, string>) => string> = {
  ConnectorLoop: connectorLoop,
  ReadPaths: readPaths,
  TenancyTree: tenancyTree,
  InstanceResolution: instanceResolution,
  PermissionPipeline: permissionPipeline,
  LayerStack: layerStack,
  RuntimeTopology: runtimeTopology,
  ScopeTopology: scopeTopology,
  StateMachine: stateMachine,
  BlastRadius: blastRadius,
  GuardPath: guardPath,
};

/** The twin for `<Name … />`, or null when the component has no flattening. */
export function altFor(
  component: string,
  props: Record<string, string> = {},
): string | null {
  return COMPONENT_ALT[component]?.(props) ?? null;
}
