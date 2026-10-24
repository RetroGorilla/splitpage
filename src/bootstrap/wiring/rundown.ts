import type { ActionDefinition } from "../../application/actions.ts";
import { documentReader as portDocument } from "./ports/document.ts";
import { text as portText } from "./ports/text.ts";
import { review as portReview } from "./ports/location.ts";
import { actions as portActions } from "./ports/actions.ts";
import { changes as portChanges } from "./ports/preferences.ts";
import { edits as portEdits } from "./ports/editing.ts";
import { notices as portNotices } from "./ports/effects.ts";
import { screen as portScreen } from "./ports/screen.ts";
import { owned } from "../../features/routing/owned.ts";
import { rundownMinimizeActions as minimizeDefinitions, rundownSceneActions as sceneDefinitions } from "../../features/rundown/actions.ts";
import type { RundownPorts, RundownPresencePorts, TargetMount, TargetPorts } from "../../features/rundown/ports.ts";
import { __init as mountPresence } from "../../features/rundown/presence.js";
import { __init as mountRundown } from "../../features/rundown/rundown.js";
import { __init as mountTarget } from "../../features/rundown/target.js";
import { cellEditing, rowDrag } from "../../legacy/editor-bridge.ts";
import { preferences } from "../../legacy/preferences-bridge.ts";
import { presence as presenceOwner } from "../../legacy/presence-bridge.ts";
import { handTargetSectionTo } from "../../legacy/target-section.ts";

const rundown = owned<ReturnType<typeof mountRundown>>();

export function mountRundownFeature(): ReturnType<typeof mountRundown> {
  return rundown.replace(function () {
    const ports: RundownPorts = {
      document: portDocument,
      text: portText,
      rowDrag: { dragging: () => rowDrag().dragging(), end: () => { rowDrag().end(); } },
      cells: { moveRow: (rowId, targetId, after) => { cellEditing().moveRow(rowId, targetId, after); } },
      review: portReview,
      actions: portActions,
      minimized: { rundownMin: () => preferences().rundownMin(), setRundownMin: (on) => { preferences().setRundownMin(on); } },
      changes: portChanges
    };
    return mountRundown(ports);
  });
}

export const stopRundownFeature = rundown.stop;

const presence = owned<ReturnType<typeof mountPresence>>();

export function mountRundownPresenceFeature(): ReturnType<typeof mountPresence> {
  return presence.replace(function () {
    const ports: RundownPresencePorts = {
      document: portDocument,
      presence: { shown: () => presenceOwner().shown() },
      actions: portActions
    };
    return mountPresence(ports);
  });
}

export const stopRundownPresenceFeature = presence.stop;

const target = owned<TargetMount>();

export function mountTargetFeature(): TargetMount {
  return target.replace(function () {
    const ports: TargetPorts = {
      document: portDocument,
      edits: portEdits,
      review: portReview,
      notices: portNotices
    };
    const mounted: TargetMount = mountTarget(ports);
    handTargetSectionTo(mounted.section);
    return mounted;
  });
}

export const stopTargetFeature = target.stop;

function mounted(): ReturnType<typeof mountRundown> | null {
  const owner = rundown.owner();
  return owner?.mounted() ? owner : null;
}

export function rundownMinimizeActions(): ActionDefinition[] {
  return minimizeDefinitions(mounted, portScreen);
}

export function rundownSceneActions(): ActionDefinition[] {
  return sceneDefinitions(mounted);
}
