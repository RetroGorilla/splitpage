import type { ActionDefinition } from "../../application/actions.ts";
import { owned } from "../../features/routing/owned.ts";
import { rundownMinimizeActions as minimizeDefinitions, rundownSceneActions as sceneDefinitions } from "../../features/rundown/actions.ts";
import type { RundownPorts } from "../../features/rundown/ports.ts";
import { __init as mountRundown } from "../../features/rundown/rundown.js";
import { cellEditing, rowDrag } from "../../legacy/editor-bridge.ts";
import { preferences } from "../../legacy/preferences-bridge.ts";
import { sharedPorts } from "./shared-ports.ts";

const rundown = owned<ReturnType<typeof mountRundown>>();

export function mountRundownFeature(): ReturnType<typeof mountRundown> {
  return rundown.replace(function () {
    const shared = sharedPorts();
    const ports: RundownPorts = {
      document: shared.document,
      text: shared.text,
      rowDrag: { dragging: () => rowDrag().dragging(), end: () => { rowDrag().end(); } },
      cells: { moveRow: (rowId, targetId, after) => { cellEditing().moveRow(rowId, targetId, after); } },
      review: shared.review,
      actions: shared.actions,
      minimized: { rundownMin: () => preferences().rundownMin(), setRundownMin: (on) => { preferences().setRundownMin(on); } },
      changes: shared.changes
    };
    return mountRundown(ports);
  });
}

export const stopRundownFeature = rundown.stop;

function mounted(): ReturnType<typeof mountRundown> | null {
  const owner = rundown.owner();
  return owner?.mounted() ? owner : null;
}

export function rundownMinimizeActions(): ActionDefinition[] {
  return minimizeDefinitions(mounted, sharedPorts().screen);
}

export function rundownSceneActions(): ActionDefinition[] {
  return sceneDefinitions(mounted);
}
